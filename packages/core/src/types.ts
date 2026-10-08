/** [longitude, latitude] — same order as GeoJSON and MapLibre. */
export type LngLat = [number, number];

export const EdgeKind = {
  /** footway, pedestrian plaza, corridor: walk; cyclists walk their bike */
  Path: 0,
  Steps: 1,
  /** cycleway, path designated for bikes, or a footpath on a surveyed bike path; walkable (even if
   *  tagged foot=no), but walkers keep off unless it saves real time */
  Bike: 2,
  /** traced by hand into data/custom-paths.geojson */
  Custom: 3,
  /** a road with no sidewalk, kept for walking only where it's the sole link to a campus building or bus stop */
  Road: 4,
  /** rideable but not part of the walking network: other roads, foot=no cycleways */
  BikeOnly: 5,
  /** path where riding is allowed but not designated (highway=path, bicycle=yes) */
  Shared: 6,
  /** a road you can walk along: one with a sidewalk on it (tagged, seen on UCSD's ground plan, or a
   *  residential or through road with no tag saying otherwise), or a parking lot aisle. Walk on the
   *  sidewalk (or anywhere in the lot), ride on the road */
  Sidewalk: 7,
  /** walking straight across open ground (lawn, plaza, field) between two paths that don't meet
   *  nearby; taken only when it saves a real part of the trip */
  Gap: 8,
  /** walking straight across a parking lot (you can walk anywhere in one): ordinary walking; a bike is walked across */
  Lot: 9,
} as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

/**
 * Riding direction flags of an edge ("forward" = from its first node to its second). Cyclists
 * keep right: they ride one-way roads and paths only with the traffic, so the right-hand
 * carriageway of a divided road; a bike lane counts only in the direction it serves.
 */
export const BikeDir = {
  /** One-way against this direction: no riding first -> second. */
  NoForward: 1,
  /** One-way: no riding second -> first. */
  NoBackward: 2,
  /** A bike lane (or track) for riding first -> second. */
  LaneForward: 4,
  /** A bike lane for riding second -> first. */
  LaneBackward: 8,
} as const;

/** Serialized graph written by scripts/build-graph.ts. */
export interface GraphData {
  version: 1;
  generatedAt: string;
  attribution: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  /** Flat [lon0, lat0, lon1, lat1, ...]. */
  coords: number[];
  /** Flat [from, to, kind, from, to, kind, ...]. Edges work in both directions. */
  edges: number[];
  /** Walking-network component of each node (BikeOnly edges excluded). */
  components: number[];
  /** Walking component of central campus; walking routes only start/end inside it. */
  mainComponent: number;
  /** Component of each node over every edge (the riding network). */
  bikeComponents: number[];
  mainBikeComponent: number;
  /** Ground elevation of each node in decimeters (NO_ELEVATION on bridges, in tunnels and indoors). */
  elevation?: number[];
  /** BikeDir flags per edge (missing = all 0: ride either way, no bike lane). */
  bikeDir?: number[];
  /** Path and street names, and each edge's index into them (-1 = unnamed). For directions. */
  names?: string[];
  edgeNames?: number[];
}

/** GraphData.elevation for a node off the ground (a bridge, tunnel or floor): stretches there count as level. */
export const NO_ELEVATION = -32768;

/** A door of a building, from OpenStreetMap entrance nodes. */
export interface Entrance {
  lngLat: LngLat;
  /** Graph node the route can end at, or -1 if the door isn't connected to the paths. */
  node: number;
  /** OSM entrance=* value: "main", "yes", "secondary", "emergency", "staircase"… */
  kind: string;
  /** wheelchair=* when tagged. */
  wheelchair?: "yes" | "no" | "limited";
  label?: string;
  /** OSM level=* of the floor the door opens onto, when tagged. */
  level?: string;
}

/** An indoor space: a room or corridor mapped in OpenStreetMap, or a room students pinned. */
export interface IndoorRoom {
  /** Room number ("1202"); missing for unlabelled rooms and corridors. */
  ref?: string;
  name?: string;
  /** OSM level=*, e.g. "0", "2", "-1", "0-3", "-1;0;1". */
  level?: string;
  center: LngLat;
  /** Floor-plan outline, when mapped as an area. */
  outline?: LngLat[];
  /** A corridor mapped as a line (its centre) rather than an area. */
  line?: LngLat[];
  kind: "room" | "corridor" | "area";
  /** What the space is for, when that matters for getting around: stairwells and
   *  elevators join floors, lobbies are walkable. */
  use?: "stairs" | "elevator" | "lobby";
  /** "osm": mapped in OpenStreetMap; "pinned": a student marked where it is (data/room-locations.json). */
  source: "osm" | "pinned";
}

/** Building id -> its mapped rooms. */
export type IndoorData = Record<string, IndoorRoom[]>;

/** A place students call by a name maps don't know ("Revelle bus stop"). */
export interface Place {
  id: string;
  name: string;
  aliases: string[];
  /** One or more spots; a route goes to whichever is closest. */
  points: LngLat[];
  kind: "lingo" | "stop" | "saved";
  note?: string;
}

export interface PlacesData {
  places: Place[];
  /** Tips keyed by building code or "CODE ROOM" ("WLH" / "WLH 2001"). */
  tips: Record<string, string>;
}

export interface Building {
  id: string;
  name: string;
  /** Other names people search for: short names, codes, old names. */
  aliases: string[];
  center: LngLat;
  /** Graph node indices a route may end at (entrances when mapped, else nearby path nodes). */
  targets: number[];
  /** Ride-only road nodes beside the building (roads with no sidewalk): where a bike can pull up
   *  or set off, besides the targets. */
  rideTargets?: number[];
  /** How many targets are real mapped entrances (0 = approximated from the outline). */
  entranceCount: number;
  /** "walk": reachable on foot from central campus; "shuttle": only with a shuttle ride. */
  access: "walk" | "shuttle";
  /** Rooms classes meet in, from the Schedule of Classes (when known). */
  rooms?: string[];
  /** Mapped doors, for "enter by…" hints and markers. */
  entrances?: Entrance[];
  /** building:levels from OSM. */
  levels?: number;
  /** Elevators mapped inside the building. */
  elevators?: number;
  /** Where those elevators are. */
  elevatorsAt?: LngLat[];
  /** Footprint outline rings (outer walls), for the inside view. */
  outline?: LngLat[][];
}
