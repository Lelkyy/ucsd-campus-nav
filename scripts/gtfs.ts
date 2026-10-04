/** Minimal GTFS (static) reader: just the tables the transit build needs. */
import { strFromU8, unzipSync } from "fflate";

export type Row = Record<string, string>;

export interface Gtfs {
  stops: Row[];
  routes: Row[];
  trips: Row[];
  stopTimes: Row[];
  calendar: Row[];
  calendarDates: Row[];
  shapes: Row[];
}

export function readGtfs(zip: Uint8Array): Gtfs {
  const files = unzipSync(zip);
  const table = (name: string): Row[] => {
    const key = Object.keys(files).find((k) => k === name || k.endsWith(`/${name}`));
    return key ? parseCsv(strFromU8(files[key])) : [];
  };
  return {
    stops: table("stops.txt"),
    routes: table("routes.txt"),
    trips: table("trips.txt"),
    stopTimes: table("stop_times.txt"),
    calendar: table("calendar.txt"),
    calendarDates: table("calendar_dates.txt"),
    shapes: table("shapes.txt"),
  };
}

/** "25:10:00" -> seconds after midnight (GTFS allows > 24h for late trips). */
export function toSeconds(hms: string): number {
  const [h, m, s] = hms.trim().split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.some((f) => f !== "")) records.push(record);
      record = [];
    } else field += c;
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const [header = [], ...rows] = records;
  const keys = header.map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}
