import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import type { LngLat } from "../../packages/core/src/types.ts";

/** One MTS trip from the published timetable: its route shape, and its stops with their scheduled times. */
export interface StaticTrip {
  tripId: string;
  routeId: string;
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

  const out = new Map<string, StaticTrip>();
  for (const [tripId, t] of trips) {
    const shape = (shapes.get(t.shapeId) ?? []).sort((a, b) => a.seq - b.seq).map((x) => x.p);
    const times = (stopTimes.get(tripId) ?? []).sort((a, b) => a.seq - b.seq);
    if (shape.length < 2 || !times.length) continue;
    out.set(tripId, {
      tripId,
      routeId: t.routeId,
      shape,
      stops: times.filter((s) => stops.has(s.stopId)).map((s) => ({ stopId: s.stopId, lngLat: stops.get(s.stopId)!, sched: s.sched })),
    });
  }
  return out;
}
