/**
 * Builds the campus walking graph, building list and shuttle network:
 *   1. OSM paths, roads, buildings (incl. multipolygons), entrances and the campus
 *      boundary (cached in data/raw/osm.json; --refresh re-downloads from Overpass)
 *   2. Triton Transit GTFS (cached in data/raw/gtfs/; --refresh re-downloads)
 *   3. minus ways in data/blocked-ways.json, plus hand-traced lines and named Point
 *      buildings in data/custom-paths.geojson
 *   4. roads pruned to the stretches that are the only link to a campus building or
 *      shuttle stop; pieces of network with no building or stop on them dropped
 *   5. schedule codes from data/building-codes.json (plus automatic matches) added as
 *      aliases, and checked against every room in data/rooms.json
 * Writes apps/web/public/data/{graph,buildings,transit}.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EdgeKind,
  haversine,
  type Building,
  type GraphData,
  formatCourseCode,
  type CourseSections,
  type Entrance,
  type IndoorData,
  type LngLat,
  type PlacesData,
  type SectionsData,
  type FeedFare,
  type TransitData,
  type TransitPattern,
} from "@campus/core";
import { readGtfs, toSeconds, type Row } from "./gtfs.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_OSM = join(ROOT, "data/raw/osm.json");
const RAW_GTFS_DIR = join(ROOT, "data/raw/gtfs");
const CUSTOM_PATH = join(ROOT, "data/custom-paths.geojson");
const BLOCKED_PATH = join(ROOT, "data/blocked-ways.json");
const CODES_PATH = join(ROOT, "data/building-codes.json");
const ROOMS_PATH = join(ROOT, "data/rooms.json");
const PLACES_PATH = join(ROOT, "data/places.json");
const FARES_PATH = join(ROOT, "data/fares.json");
/** Current-term schedule exported from TSS (login-only, so kept out of git). */
const PRIVATE_DIR = join(ROOT, "data/private");

/** data/building-codes.json: schedule building codes -> OSM building names ("Prefix*" matches several). */
interface CodeFile {
  codes: Record<string, string>;
  /** Codes that appear in the schedule but aren't places (e.g. "DEPT"). */
  notPlaces: string[];
  /** Real places we can't put on the map yet, with the reason. */
  unplaced: Record<string, string>;
}
const OUT_DIR = join(ROOT, "apps/web/public/data");

/** [south, west, north, east] — main campus, Scripps, east campus health. */
const BBOX = [32.86, -117.258, 32.893, -117.215] as const;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const FEEDS = [
  {
    id: "triton",
    name: "Triton Transit",
    attribution: "Shuttle schedules: UC San Diego Triton Transit (GTFS)",
    url: "https://api.us.sparelabs.com/v1/fixedRoute/public/21c87bba-e136-41bc-ba9a-191bdb3e08e4/gtfs.zip",
    areaOnly: false,
  },
  {
    // County-wide; only the stops in our area (and trips through them) are kept.
    id: "mts",
    name: "MTS",
    attribution: "Bus and trolley schedules: San Diego MTS (GTFS)",
    url: "https://www.sdmts.com/google_transit_files/google_transit.zip",
    areaOnly: true,
  },
];
type Feed = (typeof FEEDS)[number];

/** Custom-path vertices this close to an existing node join it instead of making a new one. */
const SNAP_METERS = 4;
/** While choosing which roads to keep, a road meter counts as this many path meters. */
const ROAD_AVOIDANCE = 8;
/** A shuttle stop further than this from any path isn't usable on foot. */
const STOP_SNAP_METERS = 150;

const PATH_HIGHWAYS = new Set(["footway", "path", "pedestrian", "track", "corridor", "bridleway"]);
const ROAD_HIGHWAYS = new Set([
  "service", "residential", "unclassified", "road", "living_street",
  "tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link",
]);

interface OsmNode { type: "node"; id: number; lat: number; lon: number; tags?: Record<string, string> }
interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}
interface OsmRelation {
  type: "relation";
  id: number;
  members: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}
type OsmElement = OsmNode | OsmWay | OsmRelation;

interface RawBuilding {
  id: string;
  name: string;
  tags: Record<string, string>;
  /** Outline polylines (outer rings). */
  lines: LngLat[][];
  center: LngLat;
}

/** [from, to, kind, bikes allowed, index into the path-name table or -1] */
type Edge = [number, number, EdgeKind, boolean, number];

const walkable = (kind: EdgeKind) => kind !== EdgeKind.BikeOnly;

async function main() {
  const refresh = process.argv.includes("--refresh");
  if (refresh || !existsSync(RAW_OSM)) await fetchOsm();
  for (const feed of FEEDS) {
    const path = join(RAW_GTFS_DIR, `${feed.id}.zip`);
    if (refresh || !existsSync(path)) await fetchFeed(feed, path);
  }

  const raw = JSON.parse(readFileSync(RAW_OSM, "utf8")) as { elements: OsmElement[]; osm3s?: { timestamp_osm_base?: string } };
  const blocked = new Set<number>(existsSync(BLOCKED_PATH) ? JSON.parse(readFileSync(BLOCKED_PATH, "utf8")) : []);
  const custom: GeoJSON.FeatureCollection = existsSync(CUSTOM_PATH)
    ? JSON.parse(readFileSync(CUSTOM_PATH, "utf8"))
    : { type: "FeatureCollection", features: [] };

  const ways = raw.elements.filter((el): el is OsmWay => el.type === "way");
  const relations = raw.elements.filter((el): el is OsmRelation => el.type === "relation");
  const entrances = raw.elements.filter((el): el is OsmNode => el.type === "node" && !!el.tags?.entrance);
  const toLine = (g: { lat: number; lon: number }[]) => g.map((p) => [p.lon, p.lat] as LngLat);

  // --- Full graph: paths, stairs, bike paths and (for now) every walkable road.
  const coords: LngLat[] = [];
  const osmIndex = new Map<number, number>();
  const edgeKeys = new Set<string>();
  let edges: Edge[] = [];
  // Path/street names, for turn-by-turn directions ("Turn left onto Library Walk").
  const names: string[] = [];
  const nameIds = new Map<string, number>();
  const nameId = (name?: string) => {
    if (!name) return -1;
    let id = nameIds.get(name);
    if (id === undefined) nameIds.set(name, (id = names.push(name) - 1));
    return id;
  };
  const addEdge = (a: number, b: number, kind: EdgeKind, bikeOk = true, name = -1) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push([a, b, kind, bikeOk, name]);
  };
  const osmNode = (id: number, lon: number, lat: number) => {
    let i = osmIndex.get(id);
    if (i === undefined) {
      i = coords.push([round(lon), round(lat)]) - 1;
      osmIndex.set(id, i);
    }
    return i;
  };

  let blockedCount = 0;
  for (const way of ways) {
    if (!way.tags?.highway) continue;
    const classified = edgeKind(way.tags);
    if (classified === null) continue;
    const { kind, bikeOk } = classified;
    if (blocked.has(way.id)) {
      blockedCount++;
      continue;
    }
    for (let k = 0; k + 1 < way.nodes.length; k++) {
      const a = osmNode(way.nodes[k], way.geometry[k].lon, way.geometry[k].lat);
      const b = osmNode(way.nodes[k + 1], way.geometry[k + 1].lon, way.geometry[k + 1].lat);
      addEdge(a, b, kind, bikeOk, nameId(way.tags.name));
    }
  }

  const index = new PointIndex(coords);
  for (let i = 0; i < coords.length; i++) index.add(i);
  let customCount = 0;
  const customNodes = new Set<number>();
  for (const f of custom.features) {
    if (f.geometry?.type !== "LineString") continue;
    const kind = f.properties?.kind === "steps" ? EdgeKind.Steps : EdgeKind.Custom;
    let prev = -1;
    for (const [lon, lat] of f.geometry.coordinates as LngLat[]) {
      let i = index.nearest([lon, lat], SNAP_METERS);
      if (i === -1) {
        i = coords.push([round(lon), round(lat)]) - 1;
        index.add(i);
      }
      customNodes.add(i);
      if (prev !== -1) addEdge(prev, i, kind);
      prev = i;
    }
    customCount++;
  }

  // --- Campus boundary and campus buildings.
  const campusRings = [
    ...ways.filter((w) => w.tags?.amenity === "university").map((w) => toLine(w.geometry)),
    ...relations
      .filter((r) => r.tags?.amenity === "university")
      .flatMap((r) => r.members.filter((m) => m.role !== "inner" && m.geometry).map((m) => toLine(m.geometry!))),
  ];
  const inCampus = (p: LngLat) => campusRings.some((ring) => pointInRing(p, ring));

  const rawBuildings: RawBuilding[] = [];
  const pushBuilding = (id: string, tags: Record<string, string>, lines: LngLat[][]) => {
    const pts = lines.flat();
    if (pts.length < 3) return;
    const center: LngLat = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    rawBuildings.push({ id, name: tags.name, tags, lines, center });
  };
  for (const w of ways) if (w.tags?.building && w.tags.name) pushBuilding(`w${w.id}`, w.tags, [toLine(w.geometry)]);
  for (const r of relations) {
    if (!r.tags?.building || !r.tags.name) continue;
    const outer = r.members.filter((m) => m.type === "way" && m.role !== "inner" && m.geometry);
    pushBuilding(`r${r.id}`, r.tags, outer.map((m) => toLine(m.geometry!)));
  }
  const campusBuildings = rawBuildings.filter((b) => inCampus(b.center));
  const offCampusCount = rawBuildings.length - campusBuildings.length;

  // Entrance nodes on (or within 1.5 m of) each outline.
  const entrancePts = entrances.map((e) => [e.lon, e.lat] as LngLat);
  const entranceIndex = new PointIndex(entrancePts);
  entrancePts.forEach((_, i) => entranceIndex.add(i));
  /** Indices into `entrances` of the doors on a building's outline. */
  const entrancesOf = (b: RawBuilding): number[] => {
    const found = new Set<number>();
    for (const line of b.lines) {
      for (const p of densify(line, 1)) {
        const e = entranceIndex.nearest(p, 1.5);
        if (e !== -1) found.add(e);
      }
    }
    return [...found];
  };
  const entranceNodesOf = (b: RawBuilding): number[] =>
    entrancesOf(b)
      .map((e) => osmIndex.get(entrances[e].id))
      .filter((i): i is number => i !== undefined);

  // Elevators and indoor rooms, assigned to the building they're inside.
  const elevatorPts = raw.elements
    .filter((el): el is OsmNode => el.type === "node" && el.tags?.highway === "elevator")
    .map((n) => [n.lon, n.lat] as LngLat);
  const indoorRooms = raw.elements.flatMap((el) => {
    if (el.tags?.indoor !== "room") return [];
    const ref = el.tags.ref ?? el.tags.name;
    if (!ref) return [];
    const pts =
      el.type === "node"
        ? [[el.lon, el.lat] as LngLat]
        : el.type === "way"
          ? toLine(el.geometry)
          : el.members.flatMap((m) => (m.geometry ? toLine(m.geometry) : []));
    if (!pts.length) return [];
    const center: LngLat = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    return [{ ref, name: el.tags.ref ? el.tags.name : undefined, level: el.tags.level, center }];
  });
  const inBuilding = (b: RawBuilding, p: LngLat) => b.lines.some((ring) => ring.length > 3 && pointInRing(p, ring));

  /** Route targets for a building among nodes passing `accept`. */
  const targetsOf = (b: RawBuilding, accept: (i: number) => boolean) => {
    const atEntrances = [...new Set(entranceNodesOf(b).filter(accept))];
    if (atEntrances.length) return { targets: atEntrances, entranceCount: atEntrances.length };
    const near = new Set<number>();
    for (const line of b.lines) {
      for (const p of densify(line, 10)) {
        const i = index.nearest(p, 15, accept);
        if (i !== -1) near.add(i);
      }
    }
    if (near.size === 0) {
      const i = index.nearest(b.center, 150, accept);
      if (i !== -1) near.add(i);
    }
    return { targets: [...near], entranceCount: 0 };
  };

  // --- Shuttle stops (GTFS).
  const [bs, bw, bn, be] = BBOX;
  const inArea = (s: Row) => {
    const [lat, lon] = [Number(s.stop_lat), Number(s.stop_lon)];
    return lat >= bs && lat <= bn && lon >= bw && lon <= be;
  };
  const feeds = FEEDS.map((feed) => ({
    feed,
    gtfs: readGtfs(readFileSync(join(RAW_GTFS_DIR, `${feed.id}.zip`)), feed.areaOnly ? { keepStop: inArea } : {}),
  }));
  const stopPositions = feeds.flatMap(({ gtfs }) =>
    gtfs.stops.filter((s) => !s.location_type || s.location_type === "0").map((s) => [Number(s.stop_lon), Number(s.stop_lat)] as LngLat),
  );

  // --- Keep only the roads that are the sole link to a campus building or stop:
  // the shortest-path tree from central campus, with roads heavily discouraged.
  const required = new Set<number>();
  for (const b of campusBuildings) targetsOf(b, () => true).targets.forEach((t) => required.add(t));
  for (const f of custom.features) {
    if (f.geometry?.type !== "Point" || !f.properties?.name) continue;
    const i = index.nearest(f.geometry.coordinates as LngLat, 80);
    if (i !== -1) required.add(i);
  }
  for (const p of stopPositions) {
    const i = index.nearest(p, STOP_SNAP_METERS);
    if (i !== -1) required.add(i);
  }

  const hubBuilding = campusBuildings.find((b) => b.name === "Price Center") ?? campusBuildings[0];
  const hub = targetsOf(hubBuilding, () => true).targets[0];
  const prevEdge = shortestPathTree(coords, edges, hub, (kind) =>
    kind === EdgeKind.Road ? ROAD_AVOIDANCE : walkable(kind) ? 1 : Infinity,
  );
  const usedRoads = new Set<number>();
  for (const r of required) {
    for (let v = r; prevEdge[v] !== -1; ) {
      const e = prevEdge[v];
      if (edges[e][2] === EdgeKind.Road) usedRoads.add(e);
      v = edges[e][0] === v ? edges[e][1] : edges[e][0];
    }
  }
  const totalRoads = edges.filter((e) => e[2] === EdgeKind.Road).length;
  // Other roads stay for cycling only (unless bikes are banned on them).
  edges = edges.flatMap((e, i): Edge[] => {
    if (e[2] !== EdgeKind.Road || usedRoads.has(i)) return [e];
    return e[3] ? [[e[0], e[1], EdgeKind.BikeOnly, true, e[4]]] : [];
  });

  // Drop walking pieces with no building, stop or hand-traced path on them, and
  // riding pieces that don't connect to central campus.
  const preWalk = components(coords.length, edges.filter((e) => walkable(e[2])));
  const usefulComp = new Set([...required, ...customNodes].map((i) => preWalk.id[i]));
  const preBike = components(coords.length, edges);
  const hubBikeComp = preBike.id[hub];
  edges = edges.filter(([a, , kind]) => (walkable(kind) ? usefulComp.has(preWalk.id[a]) : preBike.id[a] === hubBikeComp));

  // --- Compact node indices.
  const remap = new Int32Array(coords.length).fill(-1);
  for (const [a, b] of edges) remap[a] = remap[b] = 0;
  const finalCoords: LngLat[] = [];
  for (let i = 0; i < coords.length; i++) if (remap[i] === 0) remap[i] = finalCoords.push(coords[i]) - 1;
  const finalEdges = edges.map(([a, b, k, bike, nm]): Edge => [remap[a], remap[b], k, bike, nm]);
  // Walking connectivity ignores bike-only edges; riding connectivity uses everything.
  const comps = components(finalCoords.length, finalEdges.filter((e) => walkable(e[2])));
  const bikeComps = components(finalCoords.length, finalEdges);
  const mainComponent = comps.id[remap[hub]];
  const mainBikeComponent = bikeComps.id[remap[hub]];
  const kept = (i: number) => remap[i] !== -1;
  const walkNode = new Uint8Array(finalCoords.length);
  for (const [a, b, k] of finalEdges) if (walkable(k)) walkNode[a] = walkNode[b] = 1;

  // --- Shuttle network on the final graph (stops connect to the walking network).
  const finalIndex = new PointIndex(finalCoords);
  finalCoords.forEach((_, i) => finalIndex.add(i));
  const transit = buildTransit(feeds, (p) => finalIndex.nearest(p, STOP_SNAP_METERS, (i) => walkNode[i] === 1));
  const servedComps = new Set(transit.stops.map((s) => comps.id[s.node]));

  // --- Buildings.
  const buildings: Building[] = [];
  const indoor: IndoorData = {};
  const unreachable: string[] = [];
  const onMain = (i: number) => kept(i) && comps.id[remap[i]] === mainComponent;
  const onServed = (i: number) => kept(i) && servedComps.has(comps.id[remap[i]]);
  for (const b of campusBuildings) {
    // Prefer doors on the main network; else a piece a shuttle serves.
    let { targets, entranceCount } = targetsOf(b, onMain);
    if (targets.length === 0) ({ targets, entranceCount } = targetsOf(b, onServed));
    const finalTargets = targets.map((t) => remap[t]);
    const walkable = finalTargets.some((t) => comps.id[t] === mainComponent);
    if (finalTargets.length === 0) {
      unreachable.push(b.name);
      continue;
    }
    const aliases = ["short_name", "alt_name", "abbr_name", "official_name", "old_name", "ref", "loc_name", "name:en"]
      .flatMap((k) => (b.tags[k] ? b.tags[k].split(";").map((s) => s.trim()) : []))
      .filter((a) => a && a !== b.name);
    const doors: Entrance[] = entrancesOf(b).map((e) => {
      const n = entrances[e];
      const node = osmIndex.get(n.id);
      const wheelchair = n.tags?.wheelchair;
      return {
        lngLat: [round(n.lon), round(n.lat)],
        node: node !== undefined && kept(node) ? remap[node] : -1,
        kind: n.tags?.entrance ?? "yes",
        wheelchair: wheelchair === "yes" || wheelchair === "no" || wheelchair === "limited" ? wheelchair : undefined,
        label: n.tags?.name ?? n.tags?.ref,
      };
    });
    const elevators = elevatorPts.filter((p) => inBuilding(b, p)).length;
    const levels = Number(b.tags["building:levels"]);
    const rooms = indoorRooms.filter((r) => inBuilding(b, r.center));
    if (rooms.length) {
      indoor[b.id] = rooms.map((r) => ({ ...r, center: [round(r.center[0]), round(r.center[1])] as LngLat }));
    }
    buildings.push({
      id: b.id,
      name: b.name,
      aliases: [...new Set(aliases)],
      center: [round(b.center[0]), round(b.center[1])],
      targets: finalTargets,
      entranceCount,
      access: walkable ? "walk" : "shuttle",
      ...(doors.length ? { entrances: doors } : {}),
      ...(Number.isFinite(levels) && levels > 0 ? { levels } : {}),
      ...(elevators ? { elevators } : {}),
    });
  }
  for (const f of custom.features) {
    if (f.geometry?.type !== "Point" || !f.properties?.name) continue;
    const center = f.geometry.coordinates as LngLat;
    const target = finalIndex.nearest(center, 80, (i) => walkNode[i] === 1 && comps.id[i] === mainComponent);
    if (target === -1) {
      unreachable.push(`${f.properties.name} (custom)`);
      continue;
    }
    buildings.push({
      id: `c${f.properties.id ?? buildings.length}`,
      name: f.properties.name,
      aliases: f.properties.aliases ?? [],
      center: [round(center[0]), round(center[1])],
      targets: [target],
      entranceCount: 0,
      access: "walk",
    });
  }

  // --- Schedule building codes -> buildings, and room coverage.
  const roomsFile: { terms: string[]; rooms: Record<string, string[]> } | null = existsSync(ROOMS_PATH)
    ? JSON.parse(readFileSync(ROOMS_PATH, "utf8"))
    : null;
  // The current term's schedule (private, from TSS) adds its rooms and the course sections.
  const sections = readPrivateSections();
  const roomsData = sections ? { terms: [...(roomsFile?.terms ?? []), sections.data.term], rooms: { ...roomsFile?.rooms } } : roomsFile;
  for (const [code, rooms] of Object.entries(sections?.rooms ?? {})) {
    roomsData!.rooms[code] = [...new Set([...(roomsData!.rooms[code] ?? []), ...rooms])].sort((x, y) =>
      x.localeCompare(y, undefined, { numeric: true }),
    );
  }
  const codeFile: CodeFile = existsSync(CODES_PATH)
    ? JSON.parse(readFileSync(CODES_PATH, "utf8"))
    : { codes: {}, notPlaces: [], unplaced: {} };
  const scheduleCodes = [...new Set([...Object.keys(codeFile.codes), ...Object.keys(roomsData?.rooms ?? {})])].sort();
  const unresolved: string[] = [];
  const unplaced: string[] = [];
  const suggestions: string[] = [];
  for (const code of scheduleCodes) {
    if (codeFile.notPlaces.includes(code)) continue;
    const name = codeFile.codes[code];
    // An explicit mapping wins; otherwise a building that already carries the code
    // (an OSM ref, or a hand-placed building with the code as an alias).
    const matches = name
      ? buildings.filter((b) =>
          name.endsWith("*") ? normalize(b.name).startsWith(normalize(name.slice(0, -1))) : normalize(b.name) === normalize(name),
        )
      : buildings.filter((b) => b.aliases.some((a) => a.toUpperCase() === code));
    if (matches.length === 0) {
      if (codeFile.unplaced[code]) unplaced.push(`${code} (${codeFile.unplaced[code]})`);
      else {
        unresolved.push(name ? `${code} -> "${name}" matches no building` : code);
        // Only a suggestion: a wrong guess would send students to the wrong building.
        const guesses = autoMatchCode(code, buildings);
        if (guesses.length) suggestions.push(`${code}: ${guesses.map((g) => g.name).join(" / ")}`);
      }
      continue;
    }
    for (const b of matches) {
      if (!b.aliases.includes(code)) b.aliases.unshift(code);
      // Committed data only carries public room lists; the app adds private ones at runtime.
      const rooms = roomsFile?.rooms[code];
      if (rooms?.length) b.rooms = [...new Set([...(b.rooms ?? []), ...rooms])];
    }
  }
  buildings.sort((a, b) => a.name.localeCompare(b.name));

  // --- Write.
  const [s, w, n, e] = BBOX;
  const graph: GraphData = {
    version: 1,
    generatedAt: raw.osm3s?.timestamp_osm_base ?? new Date().toISOString(),
    attribution: "© OpenStreetMap contributors (ODbL)",
    bbox: [w, s, e, n],
    coords: finalCoords.flat(),
    edges: finalEdges.flatMap(([a, b, k]) => [a, b, k]),
    components: Array.from(comps.id),
    mainComponent,
    bikeComponents: Array.from(bikeComps.id),
    mainBikeComponent,
    names,
    edgeNames: finalEdges.map((e) => e[4]),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "graph.json"), JSON.stringify(graph));
  writeFileSync(join(OUT_DIR, "buildings.json"), JSON.stringify(buildings));
  writeFileSync(join(OUT_DIR, "transit.json"), JSON.stringify(transit));
  writeFileSync(join(OUT_DIR, "indoor.json"), JSON.stringify(indoor));
  const places = buildPlaces(transit);
  writeFileSync(join(OUT_DIR, "places.json"), JSON.stringify(places));
  if (sections) writeFileSync(join(OUT_DIR, "sections.json"), JSON.stringify(sections.data));

  const mainSize = comps.size[mainComponent];
  const roadEdges = finalEdges.filter((e) => e[2] === EdgeKind.Road).length;
  const bikeOnly = finalEdges.filter((e) => e[2] === EdgeKind.BikeOnly).length;
  const shared = finalEdges.filter((e) => e[2] === EdgeKind.Shared || e[2] === EdgeKind.Bike).length;
  const roomCount = Object.values(roomsData?.rooms ?? {}).reduce((sum, r) => sum + r.length, 0);
  const count = (a: Building["access"]) => buildings.filter((b) => b.access === a).length;
  console.log(
    [
      `nodes ${finalCoords.length}, edges ${finalEdges.length} (walking connector roads: ${roadEdges} of ${totalRoads}; bike-only: ${bikeOnly}; bike/shared paths: ${shared})`,
      `walking network: ${new Set(Array.from(comps.id).filter((_, i) => walkNode[i])).size} pieces (main: ${mainSize} nodes); riding network main: ${bikeComps.size[mainBikeComponent]} nodes`,
      `blocked ways ${blockedCount}, custom paths ${customCount}`,
      `campus buildings ${buildings.length}: ${count("walk")} on foot, ${count("shuttle")} shuttle-only, ` +
        `${buildings.filter((b) => b.entranceCount > 0).length} with mapped entrances (${offCampusCount} off-campus skipped)`,
      `transit: ${new Set(transit.patterns.map((p) => p.route)).size} routes in use, ${transit.stops.length} stops, ${transit.patterns.reduce((sum, p) => sum + p.trips.length, 0)} trips`,
      `doors: ${buildings.reduce((n, b) => n + (b.entrances?.length ?? 0), 0)} mapped on ${buildings.filter((b) => b.entrances).length} buildings; ` +
        `elevators in ${buildings.filter((b) => b.elevators).length}; indoor rooms in ${Object.keys(indoor).length} (${Object.values(indoor).flat().length} rooms)`,
      `places: ${places.places.filter((p) => p.kind === "lingo").length} student place names, ${places.places.filter((p) => p.kind === "stop").length} stops, ${Object.keys(places.tips).length} tips`,
      unreachable.length ? `UNREACHABLE campus buildings: ${unreachable.join(", ")}` : "every campus building is reachable",
      roomsData
        ? `schedule rooms (${roomsData.terms.join(", ")}): ${scheduleCodes.length} building codes, ${roomCount} rooms`
        : "no data/rooms.json yet (npm run fetch:rooms)",
      unplaced.length ? `known unplaced codes (data/building-codes.json): ${unplaced.join("; ")}` : "",
      unresolved.length
        ? `UNRESOLVED building codes, add to data/building-codes.json: ${unresolved.join(", ")}`
        : "every building code is mapped, marked not-a-place, or listed as unplaced",
      suggestions.length ? `name-based guesses to check: ${suggestions.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Student place names

/**
 * data/places.json: names students use for spots maps don't know. Each entry
 * points at shuttle stops by name ("stops") or coordinates ("points"). Every
 * shuttle stop is also searchable by its own name.
 */
function buildPlaces(transit: TransitData): PlacesData {
  const file = existsSync(PLACES_PATH)
    ? (JSON.parse(readFileSync(PLACES_PATH, "utf8")) as {
        places: { name: string; aliases?: string[]; stops?: string[]; points?: LngLat[]; note?: string }[];
        tips?: Record<string, string>;
      })
    : { places: [], tips: {} };
  const out: PlacesData = { places: [], tips: file.tips ?? {} };
  file.places.forEach((p, i) => {
    const fromStops = (p.stops ?? []).map((name) => {
      const stop = transit.stops.find((s) => s.name === name);
      if (!stop) throw new Error(`data/places.json: "${p.name}" refers to unknown stop "${name}"`);
      return stop.lngLat;
    });
    const points = [...fromStops, ...(p.points ?? [])];
    if (!points.length) throw new Error(`data/places.json: "${p.name}" needs "stops" or "points"`);
    out.places.push({ id: `p${i}`, name: p.name, aliases: p.aliases ?? [], points, kind: "lingo", note: p.note });
  });
  // Stops by their own name; both sides of the road ("(East)"/"(West)") become one place.
  const byBase = new Map<string, LngLat[]>();
  for (const s of transit.stops) {
    const base = s.name.replace(/\s*\((North|South|East|West)\)$/, "");
    (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(s.lngLat);
  }
  for (const [name, points] of byBase) {
    out.places.push({ id: `s${out.places.length}`, name, aliases: [], points, kind: "stop", note: "Shuttle stop" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Private schedule data

/**
 * Reads data/private/fa26-meetings.tsv (+ fa26-courses.tsv for titles) into the
 * compact sections file the app uses, plus every building/room it mentions.
 */
function readPrivateSections(): { data: SectionsData; rooms: Record<string, string[]> } | null {
  const meetingsPath = join(PRIVATE_DIR, "fa26-meetings.tsv");
  if (!existsSync(meetingsPath)) return null;
  const tsv = (path: string) => {
    if (!existsSync(path)) return [];
    const [header, ...lines] = readFileSync(path, "utf8").trimEnd().split("\n");
    const keys = header.split("\t");
    return lines.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [keys[i], v])));
  };
  const titles = new Map(tsv(join(PRIVATE_DIR, "fa26-courses.tsv")).map((r) => [r.course, r.title]));
  const byCourse = new Map<string, CourseSections>();
  const rooms: Record<string, Set<string>> = {};
  for (const r of tsv(meetingsPath)) {
    let course = byCourse.get(r.course);
    if (!course) {
      course = { code: formatCourseCode(r.course), title: titles.get(r.course) ?? "", meetings: [] };
      byCourse.set(r.course, course);
    }
    const building = r.mode === "In Person" ? r.building : "";
    course.meetings.push([r.section, r.type, r.kind as "C" | "F" | "M", r.days, r.date, r.start, r.end, building, building ? r.room : ""]);
    if (building) (rooms[building] ??= new Set()).add(r.room);
  }
  const courses = [...byCourse.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return {
    data: { term: "Fall 2026", courses },
    rooms: Object.fromEntries(Object.entries(rooms).map(([b, set]) => [b, [...set]])),
  };
}

// ---------------------------------------------------------------------------
// Downloads

async function fetchOsm(): Promise<void> {
  const [s, w, n, e] = BBOX;
  const bbox = `${s},${w},${n},${e}`;
  const query = `[out:json][timeout:180];
(
  way["highway"](${bbox});
  way["building"]["name"](${bbox});
  relation["building"]["name"](${bbox});
  node["entrance"](${bbox});
  node["highway"="elevator"](${bbox});
  nwr["indoor"="room"](${bbox});
  way["amenity"="university"](${bbox});
  relation["amenity"="university"](${bbox});
);
out body geom;`;
  // Public Overpass servers are often busy; cycle through them a few times.
  for (let round = 0; round < 3; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 30_000 * round));
    for (const url of OVERPASS_ENDPOINTS) {
    try {
      console.log(`Fetching OSM data from ${url} ...`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ucsd-campus-nav/0.1" },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(200_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      JSON.parse(text); // fail fast on HTML error pages
      mkdirSync(dirname(RAW_OSM), { recursive: true });
      writeFileSync(RAW_OSM, text);
      return;
    } catch (err) {
      console.warn(`  failed: ${(err as Error).message}`);
    }
    }
  }
  throw new Error("All Overpass endpoints failed; try again later.");
}

async function fetchFeed(feed: Feed, path: string): Promise<void> {
  console.log(`Fetching ${feed.name} GTFS ...`);
  const res = await fetch(feed.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${feed.name}: HTTP ${res.status}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// Graph helpers

/** How a way can be used: its kind, and whether bikes may ride it. */
function edgeKind(tags: Record<string, string>): { kind: EdgeKind; bikeOk: boolean } | null {
  const hw = tags.highway;
  const yes = (v?: string) => v === "yes" || v === "designated" || v === "permissive";
  const noFoot = tags.foot === "no" || (tags.access === "no" && !yes(tags.foot));
  const noBike = tags.bicycle === "no" || tags.bicycle === "dismount" || (tags.access === "no" && !yes(tags.bicycle));
  if (noFoot) {
    // Not walkable, but maybe rideable (some cycleways and roads).
    return (hw === "cycleway" || ROAD_HIGHWAYS.has(hw)) && !noBike ? { kind: EdgeKind.BikeOnly, bikeOk: true } : null;
  }
  if (hw === "steps") return { kind: EdgeKind.Steps, bikeOk: false };
  if (hw === "cycleway") return { kind: EdgeKind.Bike, bikeOk: true };
  if (PATH_HIGHWAYS.has(hw)) {
    if (tags.bicycle === "designated") return { kind: EdgeKind.Bike, bikeOk: true };
    // highway=path allows bikes unless signed otherwise; footways only when tagged.
    const shared = yes(tags.bicycle) || (hw === "path" && !noBike);
    return { kind: shared ? EdgeKind.Shared : EdgeKind.Path, bikeOk: shared };
  }
  if (ROAD_HIGHWAYS.has(hw)) return { kind: EdgeKind.Road, bikeOk: !noBike };
  return null;
}

/** Dijkstra from `source`; returns the edge used to reach each node (-1 if none). */
function shortestPathTree(coords: LngLat[], edges: Edge[], source: number, weight: (kind: EdgeKind) => number): Int32Array {
  const adj: [number, number][][] = coords.map(() => []);
  edges.forEach(([a, b], e) => {
    adj[a].push([b, e]);
    adj[b].push([a, e]);
  });
  const dist = new Float64Array(coords.length).fill(Infinity);
  const prev = new Int32Array(coords.length).fill(-1);
  const heap = new Heap();
  dist[source] = 0;
  heap.push(source, 0);
  while (heap.size) {
    const [u, d] = heap.pop();
    if (d > dist[u]) continue;
    for (const [v, e] of adj[u]) {
      const [a, b, kind] = edges[e];
      const nd = d + haversine(coords[a][0], coords[a][1], coords[b][0], coords[b][1]) * weight(kind);
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = e;
        heap.push(v, nd);
      }
    }
  }
  return prev;
}

class Heap {
  private items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(node: number, prio: number) {
    const h = this.items;
    h.push([node, prio]);
    for (let i = h.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (h[p][1] <= h[i][1]) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const h = this.items;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l][1] < h[m][1]) m = l;
        if (r < h.length && h[r][1] < h[m][1]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
}

function components(n: number, edges: Edge[]) {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const id = new Int32Array(n).fill(-1);
  const size: number[] = [];
  for (let s = 0; s < n; s++) {
    if (id[s] !== -1) continue;
    const c = size.length;
    let count = 0;
    const stack = [s];
    id[s] = c;
    while (stack.length) {
      const u = stack.pop()!;
      count++;
      for (const v of adj[u]) {
        if (id[v] === -1) {
          id[v] = c;
          stack.push(v);
        }
      }
    }
    size.push(count);
  }
  return { id, size };
}

class PointIndex {
  private cells = new Map<string, number[]>();
  constructor(
    private coords: LngLat[],
    private cellDeg = 0.0002,
  ) {}
  add(i: number) {
    const [lon, lat] = this.coords[i];
    const k = `${Math.floor(lon / this.cellDeg)},${Math.floor(lat / this.cellDeg)}`;
    (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(i);
  }
  /** Nearest indexed point within maxMeters that passes `accept`. */
  nearest(p: LngLat, maxMeters: number, accept: (i: number) => boolean = () => true): number {
    const cx = Math.floor(p[0] / this.cellDeg);
    const cy = Math.floor(p[1] / this.cellDeg);
    const r = Math.ceil(maxMeters / 18) + 1; // a cell is at least ~18 m across here
    let best = -1;
    let bestD = maxMeters;
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        for (const i of this.cells.get(`${x},${y}`) ?? []) {
          if (!accept(i)) continue;
          const d = haversine(p[0], p[1], this.coords[i][0], this.coords[i][1]);
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  }
}

/** Points along a polyline at most `stepMeters` apart. */
function densify(line: LngLat[], stepMeters: number): LngLat[] {
  const out: LngLat[] = [];
  for (let k = 0; k + 1 < line.length; k++) {
    const [a, b] = [line[k], line[k + 1]];
    const steps = Math.max(1, Math.ceil(haversine(a[0], a[1], b[0], b[1]) / stepMeters));
    for (let t = 0; t < steps; t++) out.push([a[0] + ((b[0] - a[0]) * t) / steps, a[1] + ((b[1] - a[1]) * t) / steps]);
  }
  if (line.length) out.push(line[line.length - 1]);
  return out;
}

function pointInRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function round(x: number): number {
  return Math.round(x * 1e7) / 1e7;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Transit

function buildTransit(feeds: { feed: Feed; gtfs: ReturnType<typeof readGtfs> }[], snap: (p: LngLat) => number): TransitData {
  const data: TransitData = {
    version: 1,
    generatedAt: new Date().toISOString(),
    feeds: feeds.map(({ feed }) => ({ id: feed.id, name: feed.name, attribution: feed.attribution })),
    stops: [],
    routes: [],
    services: [],
    patterns: [],
    fares: readFares(),
  };
  for (const { feed, gtfs } of feeds) {
    const stopIdx = new Map<string, number>();
    for (const s of gtfs.stops) {
      if (s.location_type && s.location_type !== "0") continue;
      const lngLat: LngLat = [Number(s.stop_lon), Number(s.stop_lat)];
      const node = snap(lngLat);
      if (node === -1) continue; // off our map: riders just stay on the bus through it
      stopIdx.set(s.stop_id, data.stops.push({ id: `${feed.id}:${s.stop_id}`, name: s.stop_name, lngLat, node }) - 1);
    }

    const routeIdx = new Map<string, number>();
    for (const r of gtfs.routes) {
      const color = r.route_color ? `#${r.route_color}` : "#7b61ff";
      const mode = feed.id === "triton" ? "shuttle" : r.route_type === "0" ? "trolley" : "bus";
      routeIdx.set(
        r.route_id,
        data.routes.push({ id: `${feed.id}:${r.route_id}`, short: r.route_short_name, long: r.route_long_name, color, feed: feed.id, mode }) - 1,
      );
    }

    const serviceIdx = new Map<string, number>();
    const service = (id: string) => {
      let i = serviceIdx.get(id);
      if (i === undefined) {
        i = data.services.push({ days: Array(7).fill(false), start: "99999999", end: "00000000", added: [], removed: [] }) - 1;
        serviceIdx.set(id, i);
      }
      return i;
    };
    for (const c of gtfs.calendar) {
      const s = data.services[service(c.service_id)];
      s.days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => c[d] === "1");
      s.start = c.start_date;
      s.end = c.end_date;
    }
    for (const c of gtfs.calendarDates) {
      const s = data.services[service(c.service_id)];
      (c.exception_type === "1" ? s.added : s.removed).push(c.date);
    }

    const shapes = new Map<string, { seq: number; p: LngLat }[]>();
    for (const p of gtfs.shapes) {
      const list = shapes.get(p.shape_id) ?? shapes.set(p.shape_id, []).get(p.shape_id)!;
      list.push({ seq: Number(p.shape_pt_sequence), p: [Number(p.shape_pt_lon), Number(p.shape_pt_lat)] });
    }
    const shapeLine = (id: string) => shapes.get(id)?.sort((a, b) => a.seq - b.seq).map((x) => x.p);

    const stopTimes = new Map<string, { seq: number; stop: string; time: number }[]>();
    for (const st of gtfs.stopTimes) {
      const list = stopTimes.get(st.trip_id) ?? stopTimes.set(st.trip_id, []).get(st.trip_id)!;
      list.push({ seq: Number(st.stop_sequence), stop: st.stop_id, time: toSeconds(st.departure_time || st.arrival_time) });
    }

    const patterns = new Map<string, TransitPattern>();
    for (const trip of gtfs.trips) {
      const sts = (stopTimes.get(trip.trip_id) ?? []).sort((a, b) => a.seq - b.seq).filter((x) => stopIdx.has(x.stop));
      if (sts.length < 2 || !routeIdx.has(trip.route_id)) continue;
      const stops = sts.map((x) => stopIdx.get(x.stop)!);
      const key = `${trip.route_id}|${stops.join(",")}`;
      let pat = patterns.get(key);
      if (!pat) {
        const fullShape = shapeLine(trip.shape_id) ?? stops.map((s) => data.stops[s].lngLat);
        // Long lines (the trolley) only need the stretch between our first and last stop.
        const idx = matchStopsToShape(stops.map((s) => data.stops[s].lngLat), fullShape);
        const shape = fullShape.slice(idx[0], idx[idx.length - 1] + 1);
        pat = {
          route: routeIdx.get(trip.route_id)!,
          headsign: trip.trip_headsign || data.stops[stops[stops.length - 1]].name,
          stops,
          shape: shape.map(([x, y]) => [round(x), round(y)] as LngLat),
          shapeIndex: idx.map((i) => i - idx[0]),
          trips: [],
        };
        patterns.set(key, pat);
      }
      pat.trips.push({ service: service(trip.service_id), times: sts.map((x) => x.time) });
    }
    for (const pat of patterns.values()) {
      pat.trips.sort((a, b) => a.times[0] - b.times[0]);
      data.patterns.push(pat);
    }
  }
  return data;
}

function readFares(): Record<string, FeedFare> {
  const file = JSON.parse(readFileSync(FARES_PATH, "utf8")) as { feeds: Record<string, FeedFare> };
  for (const feed of FEEDS) {
    if (!file.feeds[feed.id]) throw new Error(`data/fares.json has no fare for feed "${feed.id}"`);
  }
  return file.feeds;
}

/** Index of the shape point nearest each stop, never going backwards along the shape. */
function matchStopsToShape(stops: LngLat[], shape: LngLat[]): number[] {
  const out: number[] = [];
  let from = 0;
  for (const s of stops) {
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < shape.length; i++) {
      const d = haversine(s[0], s[1], shape[i][0], shape[i][1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
      // Stop at the first close approach so loop routes don't jump to a later pass.
      if (bestD < 40 && d > bestD + 150) break;
    }
    out.push(best);
    from = best;
  }
  return out;
}

/**
 * Guess which building a schedule code means from its name: initials
 * ("WLH" = Warren Lecture Hall) or the start of the first word ("MANDE" =
 * Mandeville Center). Returns every candidate; callers only trust a single match.
 */
function autoMatchCode(code: string, buildings: Building[]): Building[] {
  return buildings.filter((b) => {
    const words = normalize(b.name)
      .split(" ")
      .filter((w) => !["and", "of", "the", "for", "at"].includes(w));
    if (!words.length) return false;
    const initials = words.map((w) => w[0]).join("").toUpperCase();
    const first = words[0].toUpperCase();
    return initials === code || (code.length >= 4 && first.startsWith(code));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
