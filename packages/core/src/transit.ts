import { haversine } from "./geo.ts";
import type { CampusGraph } from "./graph.ts";
import type { LngLat } from "./types.ts";

/** Serialized shuttle/bus network written by scripts/build-graph.ts from GTFS feeds. */
export interface TransitData {
  version: 1;
  generatedAt: string;
  feeds: { id: string; name: string; attribution: string }[];
  stops: TransitStop[];
  routes: TransitRoute[];
  services: TransitService[];
  patterns: TransitPattern[];
}

export interface TransitStop {
  id: string;
  name: string;
  lngLat: LngLat;
  /** Walking-graph node the stop connects to. */
  node: number;
}

export interface TransitRoute {
  id: string;
  short: string;
  long: string;
  /** "#rrggbb" */
  color: string;
}

export interface TransitService {
  /** Monday..Sunday flags. */
  days: boolean[];
  /** YYYYMMDD, inclusive. */
  start: string;
  end: string;
  added: string[];
  removed: string[];
}

/** One stop sequence of a route; every trip in it visits the same stops. */
export interface TransitPattern {
  route: number;
  headsign: string;
  stops: number[];
  /** Polyline for drawing, and the shape index nearest each stop. */
  shape: LngLat[];
  shapeIndex: number[];
  /** Sorted by departure. times[i] = seconds after local midnight at stops[i]. */
  trips: { service: number; times: number[] }[];
}

/** Transit data indexed for routing over a particular walking graph. */
export class TransitNetwork {
  /** Patterns (and position in them) serving each stop. */
  readonly stopPatterns: { pattern: number; pos: number }[][];
  /** Stops attached to each walking node, with the walk distance. */
  readonly nodeStops = new Map<number, { stop: number; meters: number }[]>();
  readonly stopWalkMeters: number[];

  constructor(
    readonly data: TransitData,
    graph: CampusGraph,
  ) {
    this.stopPatterns = data.stops.map(() => []);
    data.patterns.forEach((p, pattern) => p.stops.forEach((s, pos) => this.stopPatterns[s].push({ pattern, pos })));
    this.stopWalkMeters = data.stops.map((s, i) => {
      const [lon, lat] = graph.coord(s.node);
      const meters = haversine(lon, lat, s.lngLat[0], s.lngLat[1]);
      const list = this.nodeStops.get(s.node) ?? [];
      list.push({ stop: i, meters });
      this.nodeStops.set(s.node, list);
      return meters;
    });
  }

  /** Service ids running on the local calendar date of `d`. */
  activeServices(d: Date): Set<number> {
    const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const weekday = (d.getDay() + 6) % 7; // Monday = 0
    const active = new Set<number>();
    this.data.services.forEach((s, i) => {
      if (s.removed.includes(ymd)) return;
      if (s.added.includes(ymd) || (s.days[weekday] && ymd >= s.start && ymd <= s.end)) active.add(i);
    });
    return active;
  }
}

export function secondsSinceMidnight(d: Date): number {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
