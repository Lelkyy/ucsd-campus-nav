import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import type { LngLat } from "../../packages/core/src/types.ts";

/** One MTS trip from the published timetable: its route shape, and its stops with their scheduled times. */
export interface StaticTrip {
  tripId: string;
  routeId: string;
  /** Shared by every trip on the same shape (shapeId), so keep it read-only. */
  shapeId: string;
  shape: LngLat[];
  stops: { stopId: string; lngLat: LngLat; /** Scheduled arrival, seconds after the service day's midnight (past 24 h after midnight). */ sched: number }[];
}

/** Every line of a CSV file as fields, by the header's column names. Handles quoted fields. */
function* rows(text: string): Generator<Record<string, string>> {
  let i = 0;
  const line = (): string[] | null => {
    if (i >= text.length) return null;
    const out: string[] = [];
    let field = "";
    let quoted = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") out.push(field), (field = "");
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        i++;
        break;
      } else field += c;
    }
    out.push(field);
    return out;
  };
  const header = line()!.map((h) => h.replace(/^﻿/, ""));
  for (let fields = line(); fields; fields = line()) {
    if (fields.length === 1 && fields[0] === "") continue;
    const row: Record<string, string> = {};
    header.forEach((h, k) => (row[h] = fields[k] ?? ""));
    yield row;
  }
}

const seconds = (hms: string) => {
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s;
};

/** The trips in `tripIds` from an MTS GTFS zip (data/raw/gtfs/mts.zip). Trips the timetable doesn't have are left out. */
export function loadTrips(zipPath: string, tripIds: Set<string>): Map<string, StaticTrip> {
  const files = unzipSync(new Uint8Array(readFileSync(zipPath)), {
    filter: (f) => ["trips.txt", "stop_times.txt", "shapes.txt", "stops.txt"].includes(f.name),
  });
  const text = (name: string) => strFromU8(files[name]);

  const trips = new Map<string, { routeId: string; shapeId: string }>();
  for (const r of rows(text("trips.txt"))) if (tripIds.has(r.trip_id)) trips.set(r.trip_id, { routeId: r.route_id, shapeId: r.shape_id });

  const stopTimes = new Map<string, { seq: number; stopId: string; sched: number }[]>();
  for (const r of rows(text("stop_times.txt"))) {
    if (!trips.has(r.trip_id)) continue;
    const list = stopTimes.get(r.trip_id) ?? [];
    list.push({ seq: Number(r.stop_sequence), stopId: r.stop_id, sched: seconds(r.arrival_time || r.departure_time) });
    stopTimes.set(r.trip_id, list);
  }

  const shapeIds = new Set([...trips.values()].map((t) => t.shapeId));
  const shapes = new Map<string, { seq: number; p: LngLat }[]>();
  for (const r of rows(text("shapes.txt"))) {
    if (!shapeIds.has(r.shape_id)) continue;
    const list = shapes.get(r.shape_id) ?? [];
    list.push({ seq: Number(r.shape_pt_sequence), p: [Number(r.shape_pt_lon), Number(r.shape_pt_lat)] });
    shapes.set(r.shape_id, list);
  }

  const stops = new Map<string, LngLat>();
  for (const r of rows(text("stops.txt"))) stops.set(r.stop_id, [Number(r.stop_lon), Number(r.stop_lat)]);

  // One array per shape, shared by its trips: thousands of trips run a few hundred shapes.
  const shapePoints = new Map<string, LngLat[]>();
  for (const [id, pts] of shapes) shapePoints.set(id, pts.sort((a, b) => a.seq - b.seq).map((x) => x.p));
  const out = new Map<string, StaticTrip>();
  for (const [tripId, t] of trips) {
    const shape = shapePoints.get(t.shapeId) ?? [];
    const times = (stopTimes.get(tripId) ?? []).sort((a, b) => a.seq - b.seq);
    if (shape.length < 2 || !times.length) continue;
    out.set(tripId, {
      tripId,
      routeId: t.routeId,
      shapeId: t.shapeId,
      shape,
      stops: times.filter((s) => stops.has(s.stopId)).map((s) => ({ stopId: s.stopId, lngLat: stops.get(s.stopId)!, sched: s.sched })),
    });
  }
  return out;
}

/**
 * A trip's timetable in real time: each stop's scheduled arrival (ms), and the scheduled time at any point along
 * the trip (between the stops either side). The service day is whichever midnight puts the first stop nearest
 * `seenAt`, a moment the trip was running (GTFS times run past 24:00 for trips after midnight).
 */
export function tripSchedule(trip: StaticTrip, alongs: number[], seenAt: number): { sched: number[]; schedAt: (along: number) => number } {
  const midnight = (daysBack: number) => {
    const d = new Date(seenAt);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - daysBack);
    return d.getTime();
  };
  const first = trip.stops[0].sched * 1000;
  const base = [midnight(0), midnight(1)].sort((a, b) => Math.abs(a + first - seenAt) - Math.abs(b + first - seenAt))[0];
  const sched = trip.stops.map((s) => base + s.sched * 1000);
  const schedAt = (along: number) => {
    if (along <= alongs[0]) return sched[0];
    for (let k = 1; k < alongs.length; k++) {
      if (along > alongs[k]) continue;
      const span = alongs[k] - alongs[k - 1];
      return span > 0 ? sched[k - 1] + ((along - alongs[k - 1]) / span) * (sched[k] - sched[k - 1]) : sched[k];
    }
    return sched[sched.length - 1];
  };
  return { sched, schedAt };
}

/**
 * The whole MTS timetable, held compactly for a long-running process: every trip's stops and scheduled times in
 * typed arrays, every shape as one array of coordinates. A trip's StaticTrip is built when asked for, its shape
 * shared with the other trips on it. About 50 MB, against hundreds for the text it comes from.
 */
export class Timetable {
  private readonly tripIndex = new Map<string, number>();
  private readonly tripRoute: string[] = [];
  private readonly tripShape: string[] = [];
  /** Trip k's stops are stopIdx[stopStart[k] .. stopStart[k + 1]), with times sched[…] (seconds). */
  private stopStart = new Int32Array(0);
  private stopIdx = new Int32Array(0);
  private sched = new Int32Array(0);
  private readonly stopIds: string[] = [];
  private stopCoords = new Float64Array(0);
  private readonly shapeCoords = new Map<string, Float64Array>();
  private readonly shapeCache = new Map<string, LngLat[]>();

  static load(zipPath: string): Timetable {
    const t = new Timetable();
    const files = unzipSync(new Uint8Array(readFileSync(zipPath)), {
      filter: (f) => ["trips.txt", "stop_times.txt", "shapes.txt", "stops.txt"].includes(f.name),
    });
    const text = (name: string) => strFromU8(files[name]);

    const stopIndex = new Map<string, number>();
    const coords: number[] = [];
    for (const r of rows(text("stops.txt"))) {
      stopIndex.set(r.stop_id, t.stopIds.length);
      t.stopIds.push(r.stop_id);
      coords.push(Number(r.stop_lon), Number(r.stop_lat));
    }
    t.stopCoords = Float64Array.from(coords);

    for (const r of rows(text("trips.txt"))) {
      t.tripIndex.set(r.trip_id, t.tripRoute.length);
      t.tripRoute.push(r.route_id);
      t.tripShape.push(r.shape_id);
    }

    // Stop times, grouped by trip and put in order.
    const byTrip: { seq: number; stop: number; sched: number }[][] = t.tripRoute.map(() => []);
    for (const r of rows(text("stop_times.txt"))) {
      const k = t.tripIndex.get(r.trip_id);
      const s = stopIndex.get(r.stop_id);
      if (k === undefined || s === undefined) continue;
      byTrip[k].push({ seq: Number(r.stop_sequence), stop: s, sched: seconds(r.arrival_time || r.departure_time) });
    }
    t.stopStart = new Int32Array(byTrip.length + 1);
    let n = 0;
    byTrip.forEach((list, k) => ((t.stopStart[k] = n), (n += list.length)));
    t.stopStart[byTrip.length] = n;
    t.stopIdx = new Int32Array(n);
    t.sched = new Int32Array(n);
    byTrip.forEach((list, k) => {
      list.sort((a, b) => a.seq - b.seq);
      list.forEach((x, j) => ((t.stopIdx[t.stopStart[k] + j] = x.stop), (t.sched[t.stopStart[k] + j] = x.sched)));
    });

    const shapes = new Map<string, { seq: number; lon: number; lat: number }[]>();
    for (const r of rows(text("shapes.txt"))) {
      const list = shapes.get(r.shape_id) ?? [];
      list.push({ seq: Number(r.shape_pt_sequence), lon: Number(r.shape_pt_lon), lat: Number(r.shape_pt_lat) });
      shapes.set(r.shape_id, list);
    }
    for (const [id, pts] of shapes) {
      pts.sort((a, b) => a.seq - b.seq);
      const arr = new Float64Array(pts.length * 2);
      pts.forEach((p, j) => ((arr[2 * j] = p.lon), (arr[2 * j + 1] = p.lat)));
      t.shapeCoords.set(id, arr);
    }
    return t;
  }

  get size(): number {
    return this.tripRoute.length;
  }

  /** One trip, or undefined when the timetable doesn't have it (or it has no shape or stops). */
  trip(tripId: string): StaticTrip | undefined {
    const k = this.tripIndex.get(tripId);
    if (k === undefined) return undefined;
    const shapeId = this.tripShape[k];
    let shape = this.shapeCache.get(shapeId);
    if (!shape) {
      const c = this.shapeCoords.get(shapeId);
      if (!c) return undefined;
      shape = Array.from({ length: c.length / 2 }, (_, j): LngLat => [c[2 * j], c[2 * j + 1]]);
      this.shapeCache.set(shapeId, shape);
    }
    const stops: StaticTrip["stops"] = [];
    for (let j = this.stopStart[k]; j < this.stopStart[k + 1]; j++) {
      const s = this.stopIdx[j];
      stops.push({ stopId: this.stopIds[s], lngLat: [this.stopCoords[2 * s], this.stopCoords[2 * s + 1]], sched: this.sched[j] });
    }
    if (shape.length < 2 || !stops.length) return undefined;
    return { tripId, routeId: this.tripRoute[k], shapeId, shape, stops };
  }
}
