/** [longitude, latitude] — same order as GeoJSON and MapLibre. */
export type LngLat = [number, number];

export const EdgeKind = {
  /** footway, pedestrian plaza, corridor: walk; cyclists walk their bike */
  Path: 0,
  Steps: 1,
  /** cycleway or path designated for bikes; walkable too */
  Bike: 2,
  /** traced by hand into data/custom-paths.geojson */
  Custom: 3,
  /** a road kept for walking because it's the sole link to a campus building or bus stop */
  Road: 4,
  /** rideable but not part of the walking network: other roads, foot=no cycleways */
  BikeOnly: 5,
  /** path where riding is allowed but not designated (highway=path, bicycle=yes) */
  Shared: 6,
} as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

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
}

export interface Building {
  id: string;
  name: string;
  /** Other names people search for: short names, codes, old names. */
  aliases: string[];
  center: LngLat;
  /** Graph node indices a route may end at (entrances when mapped, else nearby path nodes). */
  targets: number[];
  /** How many targets are real mapped entrances (0 = approximated from the outline). */
  entranceCount: number;
  /** "walk": reachable on foot from central campus; "shuttle": only with a shuttle ride. */
  access: "walk" | "shuttle";
  /** Rooms classes meet in, from the Schedule of Classes (when known). */
  rooms?: string[];
}
