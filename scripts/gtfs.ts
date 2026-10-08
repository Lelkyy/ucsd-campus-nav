/** Minimal GTFS (static) reader: just the tables the transit build needs. */
import { strFromU8, unzipSync } from "fflate";

export type Row = Record<string, string>;

export interface Gtfs {
  agency: Row[];
  stops: Row[];
  routes: Row[];
  trips: Row[];
  stopTimes: Row[];
  calendar: Row[];
  calendarDates: Row[];
  shapes: Row[];
  routeNetworks: Row[];
}

/**
 * Read a GTFS zip. With `keepStop`, only stops it accepts are kept, along with
 * the stop times at them, the trips that visit at least two of them, and those
 * trips' shapes — so a county-wide feed shrinks to the area we map.
 */
export function readGtfs(zip: Uint8Array, opts: { keepStop?: (stop: Row) => boolean } = {}): Gtfs {
  const files = unzipSync(zip);
  const text = (name: string): string => {
    const key = Object.keys(files).find((k) => k === name || k.endsWith(`/${name}`));
    return key ? strFromU8(files[key]) : "";
  };
  const table = (name: string, keep?: (row: Row) => boolean) => parseCsv(text(name), keep);

  const stops = table("stops.txt", opts.keepStop);
  const stopIds = new Set(stops.map((s) => s.stop_id));
  const stopTimes = opts.keepStop ? table("stop_times.txt", (r) => stopIds.has(r.stop_id)) : table("stop_times.txt");
  const perTrip = new Map<string, number>();
  for (const st of stopTimes) perTrip.set(st.trip_id, (perTrip.get(st.trip_id) ?? 0) + 1);
  const trips = table("trips.txt", opts.keepStop ? (t) => (perTrip.get(t.trip_id) ?? 0) >= 2 : undefined);
  const shapeIds = new Set(trips.map((t) => t.shape_id));
  return {
    agency: table("agency.txt"),
    stops,
    routes: table("routes.txt"),
    trips,
    stopTimes,
    calendar: table("calendar.txt"),
    calendarDates: table("calendar_dates.txt"),
    shapes: table("shapes.txt", opts.keepStop ? (p) => shapeIds.has(p.shape_id) : undefined),
    routeNetworks: table("route_networks.txt"),
  };
}

/** "25:10:00" -> seconds after midnight (GTFS allows > 24h for late trips). */
export function toSeconds(hms: string): number {
  const [h, m, s] = hms.trim().split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

/**
 * Line-at-a-time CSV parsing (GTFS fields don't contain newlines), so big tables
 * can be filtered without building an object for every row.
 */
function parseCsv(text: string, keep?: (row: Row) => boolean): Row[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const keys = splitLine(lines[0] ?? "").map((h) => h.trim());
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const fields = line.includes('"') ? splitLine(line) : line.split(",");
    const row: Row = {};
    for (let k = 0; k < keys.length; k++) row[keys[k]] = (fields[k] ?? "").trim();
    if (!keep || keep(row)) out.push(row);
  }
  return out;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(field);
      field = "";
    } else field += c;
  }
  out.push(field);
  return out;
}
