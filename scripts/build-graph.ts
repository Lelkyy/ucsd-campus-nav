/**
 * Builds the campus walking graph, building list and shuttle network:
 *   1. OSM paths, roads, buildings (incl. multipolygons), entrances and the campus
 *      boundary (cached in data/raw/osm.json; --refresh re-downloads from Overpass)
 *   2. Triton Transit GTFS (cached in data/raw/gtfs/; --refresh re-downloads)
 *   3. minus ways in data/blocked-ways.json, plus hand-traced lines and named Point
 *      buildings in data/custom-paths.geojson
 *   4. roads pruned to the stretches that are the only link to a campus building or
 *      shuttle stop; pieces of network with no building or stop on them dropped
 *   4b. UC San Diego's surveyed ground plan (sidewalks, walking paths, bike paths and streets
 *      from the Campus Map; cached in data/raw/ucsd-ground.json): walkways OSM is missing
 *      traced in, footpaths that are really bike paths marked as such, and roads OSM doesn't
 *      tag checked for a sidewalk alongside
 *   5. UC San Diego's building list (official names, codes and footprints from the
 *      public Campus Map, used with the campus GIS team's OK; cached in
 *      data/raw/ucsd-buildings.geojson): aliases for buildings OSM has, and the
 *      buildings OSM is missing or hasn't named
 *   6. schedule codes from data/building-codes.json (plus automatic matches) added as
 *      aliases, and checked against every room in data/rooms.json
 * Writes apps/web/public/data/{graph,buildings,transit}.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BikeDir,
  EdgeKind,
  haversine,
  type Building,
  type GraphData,
  formatCourseCode,
  type CourseSections,
  type Entrance,
  type IndoorData,
  type IndoorRoom,
  type LngLat,
  type PlacesData,
  type SectionsData,
  type FeedFare,
  type TransitData,
  type TransitPattern,
} from "@campus/core";
import { readGtfs, toSeconds, type Row } from "./gtfs.ts";
import { Cell, fetchGround, GroundGrid, traceMissing, type GroundShape } from "./ground.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_OSM = join(ROOT, "data/raw/osm.json");
const RAW_GTFS_DIR = join(ROOT, "data/raw/gtfs");
const RAW_UCSD = join(ROOT, "data/raw/ucsd-buildings.geojson");
const RAW_UCSD_POINTS = join(ROOT, "data/raw/ucsd-building-points.geojson");
const RAW_GROUND = join(ROOT, "data/raw/ucsd-ground.json");
/** Building footprints from UC San Diego's public Campus Map (campusmap.ucsd.edu). */
const UCSD_BUILDINGS = "https://admin-enterprise-gis.ucsd.edu/server/rest/services/AdministrationServices/Buildings_Public/MapServer";
const UCSD_QUERY = "/query?where=1%3D1&outFields=OBJECTID,FacilityLongName,BuildingAliases&outSR=4326&resultRecordCount=2000&f=geojson";
const CUSTOM_PATH = join(ROOT, "data/custom-paths.geojson");
const BLOCKED_PATH = join(ROOT, "data/blocked-ways.json");
const CODES_PATH = join(ROOT, "data/building-codes.json");
const ROOMS_PATH = join(ROOT, "data/rooms.json");
const PLACES_PATH = join(ROOT, "data/places.json");
const ROOM_PINS_PATH = join(ROOT, "data/room-locations.json");
const FARES_PATH = join(ROOT, "data/fares.json");
/** Current-term schedule exported from TSS (login-only, so kept out of git). */
const PRIVATE_DIR = join(ROOT, "data/private");

/** data/building-codes.json: schedule building codes -> building names ("Prefix*" must still match just one). */
interface CodeFile {
  codes: Record<string, string>;
  /** Codes that appear in the schedule but aren't places (e.g. "DEPT"). */
  notPlaces: string[];
  /** Real places we can't put on the map yet, with the reason. */
  unplaced: Record<string, string>;
  /** OSM building names that are out of date -> the building's current name. */
  renames?: Record<string, string>;
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
/** While choosing which roads to keep, a road meter counts as this many path meters: high
 *  enough that a road without a sidewalk stays only where nothing else gets there. */
const ROAD_AVOIDANCE = 1000;
/** Ground already this close to a mapped path isn't traced again. */
const TRACE_COVER_METERS = 3.5;
/** A traced walkway this close to a mapped path for nearly its whole length is that path, misaligned. */
const TRACE_ALONGSIDE_METERS = 9;
/** A traced walkway that runs into a mapped path joins it at the nearest point within this. */
const TRACE_JOIN_METERS = 6;
/** How far out from a road's centre line to look for its sidewalk. */
const SIDEWALK_REACH_METERS = 14;
/** A shuttle stop further than this from any path isn't usable on foot. */
const STOP_SNAP_METERS = 150;

const PATH_HIGHWAYS = new Set(["footway", "path", "pedestrian", "track", "corridor", "bridleway"]);
const ROAD_HIGHWAYS = new Set([
  "service", "residential", "unclassified", "road", "living_street",
  "tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link",
]);

/**
 * Roads with no sidewalk tag that still almost always have one around here: residential
 * streets and through roads. Service roads (parking aisles, driveways) don't count.
 */
const LIKELY_SIDEWALK = new Set([
  "residential", "living_street", "unclassified", "tertiary", "tertiary_link", "secondary", "secondary_link",
]);

/** Service roads that are never walked along: parking lot aisles, driveways, drive-throughs. */
const NO_SIDEWALK_SERVICE = new Set(["parking_aisle", "driveway", "drive-through"]);

/** What the road's sidewalk tags say about walking along it, or undefined when it has none. */
function sidewalkTag(tags: Record<string, string>): boolean | undefined {
  const sides = [tags.sidewalk, tags["sidewalk:both"], tags["sidewalk:left"], tags["sidewalk:right"]].filter(Boolean);
  if (sides.some((v) => ["both", "left", "right", "yes"].includes(v))) return true;
  // "separate": drawn as its own footway, already in the graph; "no"/"none": nowhere to walk.
  if (sides.length) return false;
  return undefined;
}

/** Whether walking along this road means a sidewalk on it (not one mapped as its own footway). */
function hasSidewalk(tags: Record<string, string>): boolean {
  return sidewalkTag(tags) ?? (tags.highway === "living_street" || LIKELY_SIDEWALK.has(tags.highway));
}

/**
 * Whether UCSD's ground plan shows a sidewalk or walkway along this stretch of road (on either
 * side, for at least half of it), or undefined where the plan doesn't cover the road.
 */
function sidewalkOnGround(ground: GroundGrid, line: LngLat[]): boolean | undefined {
  const pts = densify(line, 5);
  let known = 0;
  let walk = 0;
  for (const p of pts) {
    if (!ground.near(p, 3, Cell.Known)) continue;
    known++;
    if (ground.near(p, SIDEWALK_REACH_METERS, Cell.Sidewalk | Cell.Walk)) walk++;
  }
  if (known < pts.length / 2) return undefined;
  return walk >= known / 2;
}

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
  /** Names and codes from UC San Diego's building list. */
  extraAliases?: string[];
}

/** [from, to, kind, bikes allowed, index into the path-name table or -1, BikeDir flags] */
type Edge = [number, number, EdgeKind, boolean, number, number];

const walkable = (kind: EdgeKind) => kind !== EdgeKind.BikeOnly;

async function main() {
  const refresh = process.argv.includes("--refresh");
  if (refresh || !existsSync(RAW_OSM)) await fetchOsm();
  if (refresh || !existsSync(RAW_UCSD) || !existsSync(RAW_UCSD_POINTS)) await fetchUcsdBuildings();
  for (const feed of FEEDS) {
    const path = join(RAW_GTFS_DIR, `${feed.id}.zip`);
    if (refresh || !existsSync(path)) await fetchFeed(feed, path);
  }
  if (refresh || !existsSync(RAW_GROUND)) {
    console.log("Fetching the UCSD Campus Map ground plan ...");
    writeFileSync(RAW_GROUND, JSON.stringify(await fetchGround(BBOX)));
  }
  const ground = groundGrid(JSON.parse(readFileSync(RAW_GROUND, "utf8")));

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
  const addEdge = (a: number, b: number, kind: EdgeKind, bikeOk = true, name = -1, dir = 0) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push([a, b, kind, bikeOk, name, dir]);
  };
  // Which level each node is on (ground, a bridge, a tunnel, indoors), so paths on different
  // levels that pass close in plan view aren't joined.
  const nodeLevels = new Map<number, Set<string>>();
  const onLevel = (i: number, level: string) => (nodeLevels.get(i) ?? nodeLevels.set(i, new Set()).get(i)!).add(level);
  const osmNode = (id: number, lon: number, lat: number) => {
    let i = osmIndex.get(id);
    if (i === undefined) {
      i = coords.push([round(lon), round(lat)]) - 1;
      osmIndex.set(id, i);
    }
    return i;
  };

  let blockedCount = 0;
  const sidewalkChecks = { yes: 0, no: 0 };
  for (const way of ways) {
    if (!way.tags?.highway) continue;
    const classified = edgeKind(way.tags);
    if (classified === null) continue;
    const { kind, bikeOk } = classified;
    const dir = bikeDirection(way.tags);
    if (blocked.has(way.id)) {
      blockedCount++;
      continue;
    }
    // Roads OSM doesn't say about: does the ground plan show a sidewalk along each stretch?
    // (Not parking aisles or driveways: a sidewalk round the lot isn't one along the aisle.)
    const askGround =
      (kind === EdgeKind.Sidewalk || kind === EdgeKind.Road) &&
      sidewalkTag(way.tags) === undefined &&
      !NO_SIDEWALK_SERVICE.has(way.tags.service ?? "");
    for (let k = 0; k + 1 < way.nodes.length; k++) {
      const a = osmNode(way.nodes[k], way.geometry[k].lon, way.geometry[k].lat);
      const b = osmNode(way.nodes[k + 1], way.geometry[k + 1].lon, way.geometry[k + 1].lat);
      const onGround = askGround ? sidewalkOnGround(ground, [coords[a], coords[b]]) : undefined;
      if (onGround !== undefined) sidewalkChecks[onGround ? "yes" : "no"]++;
      const segKind = onGround === undefined ? kind : onGround ? EdgeKind.Sidewalk : EdgeKind.Road;
      addEdge(a, b, segKind, bikeOk, nameId(way.tags.name), dir);
      onLevel(a, levelKey(way.tags));
      onLevel(b, levelKey(way.tags));
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

  // --- UCSD's ground plan: footpaths that are really bike paths, and walkways OSM is missing.
  const traced = addGroundPaths(ground, { coords, edges, edgeKeys, index, nodeLevels, addEdge });

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
  // UC San Diego's own list: its names and codes ("CSE", "HDSI") go on the OSM building
  // that is the same building; buildings OSM lacks (or hasn't named) come in with UCSD's
  // footprint. Matching is one-to-one: first by name nearby, then by shape (each middle
  // inside the other, or practically the same middle, at a similar size).
  const codeFile: CodeFile = existsSync(CODES_PATH)
    ? JSON.parse(readFileSync(CODES_PATH, "utf8"))
    : { codes: {}, notPlaces: [], unplaced: {} };
  const ucsd = readUcsdBuildings();
  const claimed = new Map<RawBuilding, (typeof ucsd)[number]>();
  const osmBuildings = [...rawBuildings];
  const dist = (a: LngLat, b: LngLat) => haversine(a[0], a[1], b[0], b[1]);
  const inside = (p: LngLat, lines: LngLat[][]) => lines.some((ring) => ring.length > 3 && pointInRing(p, ring));
  const area = (lines: LngLat[][]) => lines.reduce((sum, ring) => sum + ringArea(ring), 0);
  const unmatched: typeof ucsd = [];
  for (const u of ucsd) {
    const names = new Set([u.name, ...u.aliases].map(normalize));
    const b = osmBuildings.find((b) => !claimed.has(b) && names.has(normalize(b.name)) && dist(b.center, u.center) < 80);
    if (b) claimed.set(b, u);
    else unmatched.push(u);
  }
  const differentNames: string[] = [];
  for (const u of unmatched) {
    const size = area(u.lines);
    const b = osmBuildings.find((b) => {
      if (claimed.has(b)) return false;
      const ratio = area(b.lines) / Math.max(1, size);
      if (ratio < 0.5 || ratio > 2) return false;
      return dist(b.center, u.center) < 12 || (inside(u.center, b.lines) && inside(b.center, u.lines));
    });
    if (b) {
      claimed.set(b, u);
      differentNames.push(`${b.name} = ${u.name}`);
    } else {
      rawBuildings.push({ id: `u${u.id}`, name: u.name, tags: {}, lines: u.lines, center: u.center, extraAliases: u.aliases });
    }
  }
  for (const [b, u] of claimed) b.extraAliases = [...(b.extraAliases ?? []), u.name, ...u.aliases];
  // Buildings UCSD lists only as a point: a name for the building there, or a place of their own.
  const footprintNames = new Set(ucsd.map((u) => normalize(u.name)));
  const ucsdPoints: { name: string; aliases: string[]; at: LngLat }[] = [];
  for (const p of readUcsdPoints()) {
    if (footprintNames.has(normalize(p.name))) continue;
    const names = new Set([p.name, ...p.aliases].map(normalize));
    const b =
      rawBuildings.find((b) => [b.name, ...(b.extraAliases ?? [])].some((n) => names.has(normalize(n))) && dist(b.center, p.at) < 80) ??
      rawBuildings.find((b) => inside(p.at, b.lines));
    if (b) b.extraAliases = [...(b.extraAliases ?? []), p.name, ...p.aliases];
    else ucsdPoints.push(p);
  }
  // Outdated OSM names, fixed by hand (data/building-codes.json "renames").
  for (const b of rawBuildings) {
    const name = codeFile.renames?.[b.name];
    if (name) {
      b.extraAliases = [...(b.extraAliases ?? []), b.name];
      b.name = name;
    }
  }
  const ucsdMatched = claimed.size;
  const ucsdAdded = rawBuildings.length - osmBuildings.length;
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
  // Indoor rooms, corridors and areas (floor plans), where OpenStreetMap has them.
  const indoorRooms = raw.elements.flatMap((el): IndoorRoom[] => {
    const kind = el.tags?.indoor;
    if (kind !== "room" && kind !== "corridor" && kind !== "area") return [];
    const pts =
      el.type === "node"
        ? [[el.lon, el.lat] as LngLat]
        : el.type === "way"
          ? toLine(el.geometry)
          : el.members.flatMap((m) => (m.geometry ? toLine(m.geometry) : []));
    if (!pts.length) return [];
    const t = el.tags!;
    const closed = el.type === "way" && pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    const ring = closed ? pts.slice(0, -1) : pts;
    const center: LngLat = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    return [
      {
        ref: el.tags!.ref ?? (kind === "room" ? el.tags!.name : undefined),
        name: el.tags!.ref ? el.tags!.name : undefined,
        level: el.tags!.level,
        center,
        outline: closed ? pts : undefined,
        line: el.type === "way" && !closed && kind === "corridor" && pts.length > 1 ? pts : undefined,
        kind,
        use:
          t.stairs === "yes" || t.room === "stairs"
            ? "stairs"
            : t.highway === "elevator" || t.room === "elevator"
              ? "elevator"
              : t.room === "lobby"
                ? "lobby"
                : undefined,
        source: "osm",
      },
    ];
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

  // --- Stepping across: footpaths that come within a few meters of each other without meeting
  // in OSM (a path ending just short of another, two paths side by side) get a short link, unless
  // the walk between them is already short. Never across levels or through a building wall.
  const stepAcross = addStepAcross(coords, edges, index, nodeLevels, rawBuildings);
  for (const [a, b] of stepAcross) addEdge(a, b, EdgeKind.Path, false);

  // --- Roads without a sidewalk aren't for walking. Keep one only where it's the sole link to a
  // campus building or stop: the shortest-path tree from central campus, roads all but ruled out.
  const required = new Set<number>();
  const buildingTargets = campusBuildings.map((b) => targetsOf(b, () => true).targets);
  buildingTargets.flat().forEach((t) => required.add(t));
  const pointPlaces = [
    ...custom.features.flatMap((f) => (f.geometry?.type === "Point" && f.properties?.name ? [f.geometry.coordinates as LngLat] : [])),
    ...ucsdPoints.filter((p) => inCampus(p.at)).map((p) => p.at),
  ];
  // Places and stops hang off a walkway where there is one in reach, not off a road beside it.
  const onWalkway = new Uint8Array(coords.length);
  for (const [a, b, kind] of edges) if (walkable(kind) && kind !== EdgeKind.Road) onWalkway[a] = onWalkway[b] = 1;
  const snap = (p: LngLat, meters: number) => {
    const i = index.nearest(p, meters, (i) => onWalkway[i] === 1);
    return i !== -1 ? i : index.nearest(p, meters);
  };
  const needed: number[] = [];
  for (const at of pointPlaces) {
    const i = snap(at, 80);
    if (i !== -1) required.add(i), needed.push(i);
  }
  for (const p of stopPositions) {
    const i = snap(p, STOP_SNAP_METERS);
    if (i !== -1) required.add(i), needed.push(i);
  }

  const hubBuilding = campusBuildings.find((b) => b.name === "Price Center") ?? campusBuildings[0];
  const hub = targetsOf(hubBuilding, () => true).targets[0];
  const tree = shortestPathTree(coords, edges, hub, (kind) => (kind === EdgeKind.Road ? ROAD_AVOIDANCE : walkable(kind) ? 1 : Infinity));
  // A building needs just one way in: its cheapest-to-reach target.
  for (const ts of buildingTargets) if (ts.length) needed.push(ts.reduce((x, y) => (tree.dist[y] < tree.dist[x] ? y : x)));
  const usedRoads = new Set<number>();
  for (const r of needed) {
    for (let v = r; tree.prev[v] !== -1; ) {
      const e = tree.prev[v];
      if (edges[e][2] === EdgeKind.Road) usedRoads.add(e);
      v = edges[e][0] === v ? edges[e][1] : edges[e][0];
    }
  }
  const totalRoads = edges.filter((e) => e[2] === EdgeKind.Road).length;
  // Other roads stay for cycling only (unless bikes are banned on them).
  edges = edges.flatMap((e, i): Edge[] => {
    if (e[2] !== EdgeKind.Road || usedRoads.has(i)) return [e];
    return e[3] ? [[e[0], e[1], EdgeKind.BikeOnly, true, e[4], e[5]]] : [];
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
  const finalEdges = edges.map(([a, b, k, bike, nm, dir]): Edge => [remap[a], remap[b], k, bike, nm, dir]);
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
  // Each indoor space belongs to one building: the smallest one it's inside, so
  // overlapping outlines (an OSM building and a UCSD footprint) can't share a floor plan.
  const indoorOwner = new Map<IndoorRoom, RawBuilding>();
  for (const r of indoorRooms) {
    const owners = campusBuildings.filter((b) => inBuilding(b, r.center));
    const size = (b: RawBuilding) => b.lines.reduce((sum, ring) => sum + ringArea(ring), 0);
    const owner = owners.sort((a, b) => size(a) - size(b))[0];
    if (owner) indoorOwner.set(r, owner);
  }
  // Ride-only road nodes beside a building: where a bike can pull up when no walkway gets there.
  const rideOnly = new Uint8Array(finalCoords.length);
  for (const [a, b, k] of finalEdges) if (k === EdgeKind.BikeOnly) rideOnly[a] = rideOnly[b] = 1;
  const rideExits = (b: RawBuilding, walkTargets: number[]) => {
    const near = new Set<number>();
    const accept = (i: number) => kept(i) && rideOnly[remap[i]] === 1 && bikeComps.id[remap[i]] === mainBikeComponent;
    for (const line of b.lines) {
      for (const p of densify(line, 10)) {
        const i = index.nearest(p, 15, accept);
        if (i !== -1 && !walkTargets.includes(remap[i])) near.add(remap[i]);
      }
    }
    return [...near];
  };
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
    const rideTargets = rideExits(b, finalTargets);
    const aliases = [
      ...["short_name", "alt_name", "abbr_name", "official_name", "old_name", "ref", "loc_name", "name:en"].flatMap((k) =>
        b.tags[k] ? b.tags[k].split(";").map((s) => s.trim()) : [],
      ),
      // Shortest first, so codes like "CSE" lead.
      ...[...(b.extraAliases ?? [])].sort((x, y) => x.length - y.length),
    ].filter((a, i, all) => a && normalize(a) !== normalize(b.name) && all.findIndex((x) => normalize(x) === normalize(a)) === i);
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
        level: n.tags?.level,
      };
    });
    const rooms = indoorRooms.filter((r) => indoorOwner.get(r) === b);
    // Elevators mapped as points, or as shafts on the floor plans.
    const elevatorsAt = [...elevatorPts.filter((p) => inBuilding(b, p)), ...rooms.filter((r) => r.use === "elevator").map((r) => r.center)];
    const elevators = elevatorsAt.length;
    const levels = Number(b.tags["building:levels"]);
    if (rooms.length) {
      indoor[b.id] = rooms.map((r) => ({
        ...r,
        center: [round(r.center[0]), round(r.center[1])] as LngLat,
        outline: r.outline?.map(([x, y]) => [round(x), round(y)] as LngLat),
        line: r.line?.map(([x, y]) => [round(x), round(y)] as LngLat),
      }));
    }
    buildings.push({
      id: b.id,
      name: b.name,
      aliases: [...new Set(aliases)],
      center: [round(b.center[0]), round(b.center[1])],
      targets: finalTargets,
      ...(rideTargets.length ? { rideTargets } : {}),
      entranceCount,
      access: walkable ? "walk" : "shuttle",
      ...(doors.length ? { entrances: doors } : {}),
      ...(Number.isFinite(levels) && levels > 0 ? { levels } : {}),
      ...(elevators ? { elevators, elevatorsAt: elevatorsAt.map(([x, y]) => [round6(x), round6(y)] as LngLat) } : {}),
      outline: b.lines.map((ring) => ring.map(([x, y]) => [round6(x), round6(y)] as LngLat)),
    });
  }
  // Point buildings: hand-placed ones, and campus buildings UCSD lists without a footprint.
  const points = [
    ...custom.features.flatMap((f) =>
      f.geometry?.type === "Point" && f.properties?.name
        ? [{ id: `c${f.properties.id ?? f.properties.name}`, name: String(f.properties.name), aliases: (f.properties.aliases ?? []) as string[], at: f.geometry.coordinates as LngLat, custom: true }]
        : [],
    ),
    ...ucsdPoints.filter((p) => inCampus(p.at)).map((p, i) => ({ id: `p${i}`, name: p.name, aliases: p.aliases, at: p.at, custom: false })),
  ];
  for (const p of points) {
    const center = p.at;
    const target = finalIndex.nearest(center, 80, (i) => walkNode[i] === 1 && comps.id[i] === mainComponent);
    if (target === -1) {
      unreachable.push(`${p.name} (${p.custom ? "custom" : "UCSD point"})`);
      continue;
    }
    buildings.push({
      id: p.id,
      name: p.name,
      aliases: p.aliases,
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
  const scheduleCodes = [...new Set([...Object.keys(codeFile.codes), ...Object.keys(roomsData?.rooms ?? {})])].sort();
  const unresolved: string[] = [];
  const unplaced: string[] = [];
  const suggestions: string[] = [];
  for (const code of scheduleCodes) {
    if (codeFile.notPlaces.includes(code)) continue;
    const name = codeFile.codes[code];
    // An explicit mapping wins; otherwise a building that already carries the code
    // (an OSM ref, or a hand-placed building with the code as an alias).
    // A building's own name beats another building that lists it as an alias.
    const byName = name && !name.endsWith("*") ? buildings.filter((b) => normalize(b.name) === normalize(name)) : [];
    const matches = byName.length
      ? byName
      : name
        ? buildings.filter((b) =>
            name.endsWith("*")
              ? normalize(b.name).startsWith(normalize(name.slice(0, -1)))
              : [b.name, ...b.aliases].some((n) => normalize(n) === normalize(name)),
          )
        : buildings.filter((b) => b.aliases.some((a) => a.toUpperCase() === code));
    if (matches.length > 1) {
      // One code, one building: otherwise a class could lead to either of them.
      unresolved.push(`${code} matches ${matches.length} buildings (${matches.map((b) => b.name).join(" / ")}); name one`);
      continue;
    }
    // UC San Diego's alias lists put some codes on neighbors too (CNCB on CMM East).
    for (const b of buildings) if (!matches.includes(b)) b.aliases = b.aliases.filter((a) => a !== code);
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

  // Rooms students pinned ("CODE ROOM" -> spot + floor), for buildings without indoor maps.
  const pins = existsSync(ROOM_PINS_PATH)
    ? (JSON.parse(readFileSync(ROOM_PINS_PATH, "utf8")) as { rooms: Record<string, { at: LngLat; level?: string; note?: string }> }).rooms
    : {};
  for (const [key, pin] of Object.entries(pins)) {
    const [code, ...rest] = key.trim().split(/\s+/);
    const building = buildings.find((bd) => bd.aliases.includes(code));
    if (!building || !rest.length) throw new Error(`data/room-locations.json: "${key}" should be "CODE ROOM" with a known building code`);
    (indoor[building.id] ??= []).push({ ref: rest.join(" "), level: pin.level, center: pin.at, kind: "room", source: "pinned", name: pin.note });
  }

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
    bikeDir: finalEdges.map((e) => e[5]),
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
  const sidewalkEdges = finalEdges.filter((e) => e[2] === EdgeKind.Sidewalk).length;
  const bikeOnly = finalEdges.filter((e) => e[2] === EdgeKind.BikeOnly).length;
  const shared = finalEdges.filter((e) => e[2] === EdgeKind.Shared || e[2] === EdgeKind.Bike).length;
  const roomCount = Object.values(roomsData?.rooms ?? {}).reduce((sum, r) => sum + r.length, 0);
  const count = (a: Building["access"]) => buildings.filter((b) => b.access === a).length;
  console.log(
    [
      `nodes ${finalCoords.length}, edges ${finalEdges.length} (roads with sidewalks: ${sidewalkEdges}; step-across links: ${stepAcross.length}; walking connector roads: ${roadEdges} of ${totalRoads}; bike-only: ${bikeOnly}; bike/shared paths: ${shared})`,
      `riding: ${finalEdges.filter((e) => e[5] & (BikeDir.NoForward | BikeDir.NoBackward)).length} one-way segments (ridden only with the traffic), ` +
        `${finalEdges.filter((e) => e[5] & (BikeDir.LaneForward | BikeDir.LaneBackward)).length} with a bike lane (${finalEdges.filter((e) => (e[5] & BikeDir.LaneForward) !== 0 !== ((e[5] & BikeDir.LaneBackward) !== 0)).length} one side only)`,
      `walking network: ${new Set(Array.from(comps.id).filter((_, i) => walkNode[i])).size} pieces (main: ${mainSize} nodes); riding network main: ${bikeComps.size[mainBikeComponent]} nodes`,
      `blocked ways ${blockedCount}, custom paths ${customCount}`,
      `UCSD ground plan: ${traced.paths} walkways traced in (${(traced.meters / 1000).toFixed(1)} km, ${traced.bikePaths} of them bike paths, ${traced.joins} joins onto mapped paths); ` +
        `${traced.toBike} footpath segments marked bike path; untagged road segments with a sidewalk ${sidewalkChecks.yes}, without ${sidewalkChecks.no}`,
      process.env.VERBOSE ? `matched by shape, names differ: ${differentNames.join("; ")}` : "",
      `UCSD building list: ${ucsdMatched} matched to OSM buildings (${differentNames.length} by shape), ${ucsdAdded} added from UCSD footprints`,
      `campus buildings ${buildings.length}: ${count("walk")} on foot, ${count("shuttle")} shuttle-only, ` +
        `${buildings.filter((b) => b.entranceCount > 0).length} with mapped entrances (${offCampusCount} off-campus skipped)`,
      `transit: ${new Set(transit.patterns.map((p) => p.route)).size} routes in use, ${transit.stops.length} stops, ${transit.patterns.reduce((sum, p) => sum + p.trips.length, 0)} trips`,
      `doors: ${buildings.reduce((n, b) => n + (b.entrances?.length ?? 0), 0)} mapped on ${buildings.filter((b) => b.entrances).length} buildings; ` +
        `elevators in ${buildings.filter((b) => b.elevators).length}; indoor maps in ${Object.keys(indoor).length} buildings (${Object.values(indoor).flat().filter((r) => r.ref && r.source === "osm").length} numbered rooms, ${Object.values(indoor).flat().filter((r) => r.source === "pinned").length} pinned)`,
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
  nwr["indoor"~"^(room|corridor|area)$"](${bbox});
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

async function fetchUcsdBuildings(): Promise<void> {
  console.log("Fetching UC San Diego building list ...");
  // Layer 1: footprints; layer 0: a point per building (some have no footprint).
  for (const [layer, path] of [[1, RAW_UCSD], [0, RAW_UCSD_POINTS]] as const) {
    const res = await fetch(`${UCSD_BUILDINGS}/${layer}${UCSD_QUERY}`, {
      headers: { "User-Agent": "ucsd-campus-nav build" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`UCSD buildings: HTTP ${res.status}`);
    const data = (await res.json()) as GeoJSON.FeatureCollection;
    if (!Array.isArray(data.features)) throw new Error("UCSD buildings: unexpected response");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  }
}

/** Buildings UCSD lists only as a point (no footprint). */
function readUcsdPoints(): { name: string; aliases: string[]; at: LngLat }[] {
  if (!existsSync(RAW_UCSD_POINTS)) return [];
  const data = JSON.parse(readFileSync(RAW_UCSD_POINTS, "utf8")) as GeoJSON.FeatureCollection;
  return data.features.flatMap((f) => {
    const name = String(f.properties?.FacilityLongName ?? "").trim();
    if (!name || f.geometry?.type !== "Point") return [];
    return [{ name, aliases: splitAliases(f.properties?.BuildingAliases, name), at: f.geometry.coordinates as LngLat }];
  });
}

function splitAliases(value: unknown, name: string): string[] {
  return String(value ?? "")
    .split("|")
    .map((a) => a.trim())
    .filter((a) => a && a !== name && !/^\d+$/.test(a));
}

/** UCSD's building footprints with their names and aliases (bare numbers like "5" dropped). */
function readUcsdBuildings(): { id: number; name: string; aliases: string[]; lines: LngLat[][]; center: LngLat }[] {
  if (!existsSync(RAW_UCSD)) return [];
  const data = JSON.parse(readFileSync(RAW_UCSD, "utf8")) as GeoJSON.FeatureCollection;
  return data.features.flatMap((f) => {
    const name = String(f.properties?.FacilityLongName ?? "").trim();
    const g = f.geometry;
    if (!name || !g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) return [];
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    const lines = polys.map((rings) => rings[0] as LngLat[]);
    const pts = lines.flat();
    const center: LngLat = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const aliases = splitAliases(f.properties?.BuildingAliases, name);
    return [{ id: Number(f.properties?.OBJECTID ?? 0), name, aliases, lines, center }];
  });
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
  // Bike paths are walkable whatever their foot tag says: pedestrians use them here.
  if (hw === "cycleway") return { kind: EdgeKind.Bike, bikeOk: !noBike };
  if (noFoot) {
    // Not walkable, but maybe rideable (roads).
    return ROAD_HIGHWAYS.has(hw) && !noBike ? { kind: EdgeKind.BikeOnly, bikeOk: true } : null;
  }
  if (hw === "steps") return { kind: EdgeKind.Steps, bikeOk: false };
  if (PATH_HIGHWAYS.has(hw)) {
    if (tags.bicycle === "designated") return { kind: EdgeKind.Bike, bikeOk: true };
    // highway=path allows bikes unless signed otherwise; footways only when tagged.
    const shared = yes(tags.bicycle) || (hw === "path" && !noBike);
    return { kind: shared ? EdgeKind.Shared : EdgeKind.Path, bikeOk: shared };
  }
  if (ROAD_HIGHWAYS.has(hw)) return { kind: hasSidewalk(tags) ? EdgeKind.Sidewalk : EdgeKind.Road, bikeOk: !noBike };
  return null;
}

/**
 * Which way a cyclist may ride a way, and which way its bike lanes go (BikeDir flags, forward =
 * along the way). Traffic keeps right: a two-way road's right-hand lane (`cycleway:right`) is
 * for riding forward and its left-hand one for riding back; on a one-way, both go with traffic.
 */
function bikeDirection(t: Record<string, string>): number {
  const lane = (v?: string) => v === "lane" || v === "track";
  const sides = [t.cycleway, t["cycleway:both"], t["cycleway:left"], t["cycleway:right"]];
  // Contraflow: bikes allowed both ways on a one-way.
  const contraflow = t["oneway:bicycle"] === "no" || sides.some((v) => v?.startsWith("opposite"));
  const oneway = contraflow
    ? "no"
    : (t["oneway:bicycle"] ?? t.oneway ?? (t.junction === "roundabout" || t.junction === "circular" ? "yes" : "no"));
  const reverse = oneway === "-1" || oneway === "reverse";
  const one = reverse || oneway === "yes" || oneway === "true" || oneway === "1";
  // Flags as if the way ran in its direction of travel, then flipped for oneway=-1.
  let ahead = 0;
  let back = 0;
  if (lane(t.cycleway) || lane(t["cycleway:both"])) [ahead, back] = [1, 1];
  if (lane(t["cycleway:right"])) ahead = 1;
  if (lane(t["cycleway:left"])) one ? (ahead = 1) : (back = 1);
  if (t["cycleway:left"] === "opposite_lane" || t["cycleway:right"] === "opposite_lane" || t.cycleway === "opposite_lane") back = 1;
  const flags = (one ? BikeDir.NoBackward : 0) | (ahead ? BikeDir.LaneForward : 0) | (back ? BikeDir.LaneBackward : 0);
  return reverse ? swapDirection(flags) : flags;
}

function swapDirection(flags: number): number {
  const pairs = [
    [BikeDir.NoForward, BikeDir.NoBackward],
    [BikeDir.LaneForward, BikeDir.LaneBackward],
  ];
  return pairs.reduce((out, [f, b]) => out | (flags & f ? b : 0) | (flags & b ? f : 0), 0);
}

/** Dijkstra from `source`: each node's weighted distance and the edge used to reach it (-1 if none). */
function shortestPathTree(
  coords: LngLat[],
  edges: Edge[],
  source: number,
  weight: (kind: EdgeKind) => number,
): { dist: Float64Array; prev: Int32Array } {
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
  return { dist, prev };
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

/** A way's level: on a bridge or in a tunnel (by layer), indoors (by level), or on the ground. */
function levelKey(t: Record<string, string>): string {
  const on = (v?: string) => !!v && v !== "no";
  if (on(t.bridge)) return `bridge${t.layer ?? 1}`;
  // A passage through a building is at ground level; a real tunnel is below it.
  if (on(t.tunnel) && t.tunnel !== "building_passage") return `tunnel${t.layer ?? -1}`;
  if (t.indoor === "yes" || t.highway === "corridor" || t.level !== undefined) return `indoor${t.level ?? ""}`;
  return `ground${t.layer ?? 0}`;
}

/** How close two footpaths have to come to step from one to the other. */
const STEP_ACROSS_METERS = 5;
/** ...when the walk between them along the paths is longer than this (or this many times the gap). */
const STEP_ACROSS_DETOUR_METERS = 25;
const STEP_ACROSS_KINDS = new Set<EdgeKind>([EdgeKind.Path, EdgeKind.Shared, EdgeKind.Bike, EdgeKind.Custom, EdgeKind.Sidewalk]);

/** Links between nearby footpath points that the paths themselves don't join (see the call). */
function addStepAcross(
  coords: LngLat[],
  edges: Edge[],
  index: PointIndex,
  nodeLevels: Map<number, Set<string>>,
  buildings: { lines: LngLat[][] }[],
): [number, number][] {
  const adj: [number, number, EdgeKind][][] = coords.map(() => []);
  for (const [a, b, kind] of edges) {
    if (kind === EdgeKind.BikeOnly) continue;
    const m = haversine(coords[a][0], coords[a][1], coords[b][0], coords[b][1]);
    adj[a].push([b, m, kind]);
    adj[b].push([a, m, kind]);
  }
  // Only points on footpaths alone: not road junctions or stairs, so no shortcut skips a crossing or steps.
  const footOnly = (i: number) => adj[i].length > 0 && adj[i].every(([, , k]) => STEP_ACROSS_KINDS.has(k));
  const sameLevel = (a: number, b: number) => {
    const la = nodeLevels.get(a);
    const lb = nodeLevels.get(b);
    return !la || !lb || [...la].some((l) => lb.has(l));
  };
  // Whether the paths already get from a to b within `limit` meters (a small Dijkstra).
  const walkWithin = (a: number, b: number, limit: number) => {
    const dist = new Map<number, number>([[a, 0]]);
    const queue: [number, number][] = [[0, a]];
    while (queue.length) {
      queue.sort((x, y) => x[0] - y[0]);
      const [d, v] = queue.shift()!;
      if (v === b) return true;
      if (d > (dist.get(v) ?? Infinity)) continue;
      for (const [w, m] of adj[v]) {
        const nd = d + m;
        if (nd <= limit && nd < (dist.get(w) ?? Infinity)) {
          dist.set(w, nd);
          queue.push([nd, w]);
        }
      }
    }
    return false;
  };
  const boxes = buildings.map((b) => {
    const pts = b.lines.flat();
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  });
  const throughWall = (p: LngLat, q: LngLat) =>
    buildings.some((b, i) => {
      const [w, s, e, n] = boxes[i];
      if (Math.max(p[0], q[0]) < w || Math.min(p[0], q[0]) > e || Math.max(p[1], q[1]) < s || Math.min(p[1], q[1]) > n) return false;
      return b.lines.some((ring) => ring.some((r, k) => k > 0 && segmentsCross(p, q, ring[k - 1], r)));
    });

  const links: [number, number][] = [];
  const linked = new Set<string>();
  for (let i = 0; i < coords.length; i++) {
    if (!footOnly(i)) continue;
    const p = coords[i];
    const j = index.nearest(p, STEP_ACROSS_METERS, (j) => {
      if (j === i || !footOnly(j) || !sameLevel(i, j) || adj[i].some(([w]) => w === j)) return false;
      const gap = haversine(p[0], p[1], coords[j][0], coords[j][1]);
      return !walkWithin(i, j, Math.max(STEP_ACROSS_DETOUR_METERS, 4 * gap));
    });
    if (j === -1) continue;
    const key = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (linked.has(key) || throughWall(p, coords[j])) continue;
    linked.add(key);
    links.push([i, j]);
  }
  return links;
}

/** The ground plan as a raster over the part of the area it covers. */
function groundGrid(shapes: GroundShape[]): GroundGrid {
  let [s, w, n, e]: number[] = [BBOX[2], BBOX[3], BBOX[0], BBOX[1]];
  for (const shape of shapes) {
    for (const ring of shape.rings) {
      for (const [lon, lat] of ring) [s, w, n, e] = [Math.min(s, lat), Math.min(w, lon), Math.max(n, lat), Math.max(e, lon)];
    }
  }
  const box = [Math.max(s, BBOX[0]), Math.max(w, BBOX[1]), Math.min(n, BBOX[2]), Math.min(e, BBOX[3])] as const;
  return GroundGrid.from(box, shapes);
}

/**
 * Brings in what UCSD's ground plan knows and OSM doesn't:
 *   - footpath segments lying on a surveyed bike path become bike paths;
 *   - walkable ground (walking paths, sidewalks, bike paths) with no mapped path within a few
 *     meters is traced to centre lines and added, joined onto the mapped paths it runs into.
 * Only ground-level paths count: a tunnel or bridge doesn't cover the walkway above or below it,
 * and nothing traced joins one. (A walkway the ground plan shows under a roof is an open
 * passage at ground level, so it's kept.)
 */
function addGroundPaths(
  ground: GroundGrid,
  g: {
    coords: LngLat[];
    edges: Edge[];
    edgeKeys: Set<string>;
    index: PointIndex;
    nodeLevels: Map<number, Set<string>>;
    addEdge: (a: number, b: number, kind: EdgeKind, bikeOk?: boolean) => void;
  },
) {
  const { coords, edges, edgeKeys, index, nodeLevels, addEdge } = g;
  const onGround = (i: number) => {
    const levels = nodeLevels.get(i);
    return !levels || [...levels].some((l) => l.startsWith("ground"));
  };
  const groundWalk = (e: Edge) => walkable(e[2]) && e[2] !== EdgeKind.Road && onGround(e[0]) && onGround(e[1]);

  // Footpaths on a bike path.
  let toBike = 0;
  for (const e of edges) {
    if ((e[2] !== EdgeKind.Path && e[2] !== EdgeKind.Shared) || !groundWalk(e)) continue;
    const pts = densify([coords[e[0]], coords[e[1]]], 2);
    const onBike = pts.filter((p) => {
      const [x, y] = ground.toCell(p);
      return ground.near(p, 1.5, Cell.Bike) && !(ground.at(x, y) & (Cell.Walk | Cell.Sidewalk));
    }).length;
    if (onBike >= 0.6 * pts.length) {
      e[2] = EdgeKind.Bike;
      e[3] = true;
      toBike++;
    }
  }

  // What the mapped paths already cover, then trace the rest.
  for (const e of edges) {
    if (!groundWalk(e)) continue;
    ground.stroke(coords[e[0]], coords[e[1]], TRACE_COVER_METERS, Cell.Covered);
    ground.stroke(coords[e[0]], coords[e[1]], TRACE_ALONGSIDE_METERS, Cell.Alongside);
  }
  // (OSM and the survey disagree by a few meters in places, mostly on trails: a trace running
  // beside a mapped path the whole way is the same path again. Its ends don't count; a walkway
  // joining a path starts next to it.)
  const traces = traceMissing(ground, { minMeters: 12, spurMeters: 15, holeM2: 25 }).filter((t) => {
    const step = 2;
    const pts = densify(t.line, step).slice(TRACE_ALONGSIDE_METERS / step, -TRACE_ALONGSIDE_METERS / step);
    if (pts.length < 10 / step) return true;
    const alongside = pts.filter((p) => {
      const [x, y] = ground.toCell(p);
      return ground.at(x, y) & Cell.Alongside;
    }).length;
    return alongside < 0.85 * pts.length;
  });

  // Join points: the nearest point on a ground-level path (not stairs), splitting it there.
  const segments = new SegmentIndex(coords);
  const joinable = (e: Edge) => groundWalk(e) && e[2] !== EdgeKind.Steps;
  edges.forEach((e, i) => joinable(e) && segments.add(i, e[0], e[1]));
  const newNode = (p: LngLat) => {
    const i = coords.push([round(p[0]), round(p[1])]) - 1;
    index.add(i);
    nodeLevels.set(i, new Set(["ground0"]));
    return i;
  };
  let joins = 0;
  const join = (p: LngLat): number => {
    const hit = segments.nearest(p, TRACE_JOIN_METERS, (i) => joinable(edges[i]));
    if (!hit) return -1;
    joins++;
    const [a, b, kind, bikeOk, name, dir] = edges[hit.edge];
    const m = (i: number) => haversine(hit.at[0], hit.at[1], coords[i][0], coords[i][1]);
    if (m(a) < 1.5) return a;
    if (m(b) < 1.5) return b;
    const n = newNode(hit.at);
    edges[hit.edge] = [a, n, kind, bikeOk, name, dir];
    const added = edges.push([n, b, kind, bikeOk, name, dir]) - 1;
    for (const key of [a < n ? `${a}-${n}` : `${n}-${a}`, n < b ? `${n}-${b}` : `${b}-${n}`]) edgeKeys.add(key);
    segments.add(added, n, b);
    return n;
  };

  // Traces meet each other at shared junction points.
  const atJunction = new Map<string, number>();
  let meters = 0;
  let bikePaths = 0;
  for (const t of traces) {
    const kind = t.bikeShare > 0.5 ? EdgeKind.Bike : EdgeKind.Path;
    if (kind === EdgeKind.Bike) bikePaths++;
    const last = t.line.length - 1;
    const nodes = t.line.map((p, k) => {
      const end = k === 0 ? 0 : k === last ? 1 : -1;
      if (end === -1) return newNode(p);
      if (t.joins[end]) {
        const j = join(p);
        if (j !== -1) return j;
      }
      const key = `${p[0]},${p[1]}`;
      return atJunction.get(key) ?? atJunction.set(key, newNode(p)).get(key)!;
    });
    for (let k = 1; k < nodes.length; k++) {
      addEdge(nodes[k - 1], nodes[k], kind, kind === EdgeKind.Bike);
      meters += haversine(coords[nodes[k - 1]][0], coords[nodes[k - 1]][1], coords[nodes[k]][0], coords[nodes[k]][1]);
    }
  }
  return { paths: traces.length, meters, bikePaths, joins, toBike };
}

/** Segments (graph edges) by grid cell, for the nearest point on any of them. */
class SegmentIndex {
  private cells = new Map<string, number[]>();
  private ends = new Map<number, [number, number]>();
  constructor(
    private coords: LngLat[],
    private cellDeg = 0.0002,
  ) {}
  add(edge: number, a: number, b: number) {
    this.ends.set(edge, [a, b]);
    const [p, q] = [this.coords[a], this.coords[b]];
    const c = (v: number) => Math.floor(v / this.cellDeg);
    for (let x = c(Math.min(p[0], q[0])); x <= c(Math.max(p[0], q[0])); x++) {
      for (let y = c(Math.min(p[1], q[1])); y <= c(Math.max(p[1], q[1])); y++) {
        const k = `${x},${y}`;
        (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(edge);
      }
    }
  }
  /** Nearest point within maxMeters on an indexed segment passing `accept`. */
  nearest(p: LngLat, maxMeters: number, accept: (edge: number) => boolean): { edge: number; at: LngLat } | null {
    const kx = haversine(p[0], p[1], p[0] + 1e-4, p[1]) / 1e-4;
    const ky = haversine(p[0], p[1], p[0], p[1] + 1e-4) / 1e-4;
    const cx = Math.floor(p[0] / this.cellDeg);
    const cy = Math.floor(p[1] / this.cellDeg);
    const r = Math.ceil(maxMeters / 18) + 1;
    let best: { edge: number; at: LngLat } | null = null;
    let bestD = maxMeters;
    const seen = new Set<number>();
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        for (const e of this.cells.get(`${x},${y}`) ?? []) {
          if (seen.has(e) || !accept(e)) continue;
          seen.add(e);
          const [a, b] = this.ends.get(e)!.map((i) => this.coords[i]);
          const [ax, ay] = [(a[0] - p[0]) * kx, (a[1] - p[1]) * ky];
          const [dx, dy] = [(b[0] - a[0]) * kx, (b[1] - a[1]) * ky];
          const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d <= bestD) {
            bestD = d;
            best = { edge: e, at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
          }
        }
      }
    }
    return best;
  }
}

/** Whether segments pq and rs properly cross. */
function segmentsCross(p: LngLat, q: LngLat, r: LngLat, s: LngLat): boolean {
  const o = (a: LngLat, b: LngLat, c: LngLat) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p, q, r) !== o(p, q, s) && o(r, s, p) !== o(r, s, q);
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

/** Area of a ring in square meters (flat approximation, fine at building scale). */
function ringArea(ring: LngLat[]): number {
  const lat0 = ((ring[0]?.[1] ?? 0) * Math.PI) / 180;
  const mx = 111_320 * Math.cos(lat0);
  const my = 110_574;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * mx * (ring[i][1] * my) - ring[i][0] * mx * (ring[j][1] * my);
  return Math.abs(a / 2);
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

/** ~10 cm precision: plenty for drawing outlines, and keeps the file small. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
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
