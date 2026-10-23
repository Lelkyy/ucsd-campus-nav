/**
 * Records MTS's live feeds for the arrival-prediction model (docs/PREDICTION.md):
 *   - every vehicle's GPS fix, every 15 s (vehicle-positions-for-agency, ~21 KB);
 *   - MTS's predicted arrival and departure at every stop ahead of every trip, every 60 s
 *     (trip-updates-for-agency, ~200 KB).
 * Only what changed is written: a fix when the vehicle reports a new one, a prediction when its time moves.
 *
 * One NDJSON file per hour in OUT_DIR (default data/private/mts-log), gzipped once the hour is over:
 *   {"k":"fix","rx":<received ms>,"t":<fix ms>,"v":"910","trip":"19629352","r":"8","lon":-117.2,"lat":32.8}
 *   {"k":"pred","rx":<received ms>,"t":<prediction ms>,"v":"910","trip":"19629352","r":"8","stop":"11575","arr":<ms>,"dep":<ms>}
 *
 * Runs anywhere with Node 20+: MTS_KEY=... OUT_DIR=... npx tsx scripts/record-mts.ts
 * (on this machine the key comes from apps/web/.env.local). Stop it with Ctrl-C.
 */
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { decodeTripUpdates, decodeVehiclePositions } from "../packages/core/src/liveTransit.ts";

const ROOT = join(import.meta.dirname, "..");
const BASE = "https://realtime.sdmts.com/api/api/gtfs_realtime";
const POSITIONS_EVERY_MS = 15_000;
const PREDICTIONS_EVERY_MS = 60_000;
/** Forget a trip's last predictions once it hasn't been in the feed this long. */
const FORGET_MS = 3 * 3600_000;

const KEY = process.env.MTS_KEY ?? readKey();
const OUT_DIR = process.env.OUT_DIR ?? join(ROOT, "data/private/mts-log");

function readKey(): string {
  const env = join(ROOT, "apps/web/.env.local");
  const key = existsSync(env) ? readFileSync(env, "utf8").match(/^VITE_MTS_KEY=(.*)$/m)?.[1]?.trim() : undefined;
  if (!key) throw new Error("No MTS key: set MTS_KEY, or VITE_MTS_KEY in apps/web/.env.local.");
  return key;
}

async function fetchFeed(name: string): Promise<Uint8Array> {
  const res = await fetch(`${BASE}/${name}-for-agency/MTS.pb?key=${encodeURIComponent(KEY)}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// --- Output: one file per hour, gzipped when the hour is done.
let hour = "";
const fileFor = (h: string) => join(OUT_DIR, `${h}.ndjson`);
async function write(rows: object[]) {
  if (!rows.length) return;
  const h = new Date().toISOString().slice(0, 13);
  if (h !== hour) {
    if (hour) void gzipDone();
    hour = h;
  }
  appendFileSync(fileFor(hour), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
/** Gzip every finished hour (also any left from a run that stopped mid-hour). */
async function gzipDone() {
  for (const f of readdirSync(OUT_DIR)) {
    if (!f.endsWith(".ndjson") || f === `${hour}.ndjson`) continue;
    const path = join(OUT_DIR, f);
    await pipeline(createReadStream(path), createGzip(), createWriteStream(`${path}.gz`));
    unlinkSync(path);
  }
}

// --- Vehicle fixes: only new ones.
const lastFix = new Map<string, number>();
async function recordPositions() {
  const rx = Date.now();
  const { fixes } = decodeVehiclePositions(await fetchFeed("vehicle-positions"));
  const rows = fixes
    .filter((f) => lastFix.get(f.vehicleId) !== f.at)
    .map((f) => {
      lastFix.set(f.vehicleId, f.at);
      return { k: "fix", rx, t: f.at, v: f.vehicleId, trip: f.tripId, r: f.routeId, lon: round(f.lngLat[0]), lat: round(f.lngLat[1]) };
    });
  await write(rows);
  return rows.length;
}

// --- Predictions: only ones whose time moved (or that are new).
const lastPred = new Map<string, { arr?: number; dep?: number; seen: number }>();
async function recordPredictions() {
  const rx = Date.now();
  const { trips } = decodeTripUpdates(await fetchFeed("trip-updates"));
  const rows: object[] = [];
  for (const trip of trips) {
    for (const s of trip.stops) {
      const key = `${trip.tripId}|${s.stopId}`;
      const prev = lastPred.get(key);
      lastPred.set(key, { arr: s.arrival, dep: s.departure, seen: rx });
      if (prev && prev.arr === s.arrival && prev.dep === s.departure) continue;
      rows.push({ k: "pred", rx, t: trip.at, v: trip.vehicleId, trip: trip.tripId, r: trip.routeId, stop: s.stopId, arr: s.arrival, dep: s.departure });
    }
  }
  for (const [key, p] of lastPred) if (rx - p.seen > FORGET_MS) lastPred.delete(key);
  await write(rows);
  return rows.length;
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** MTS's server fails a request now and then (HTTP 500); try again this soon instead of waiting a whole interval. */
const RETRY_MS = 10_000;

/** Run `job` every `ms`, one at a time; a failure is logged and retried once after RETRY_MS. */
function every(ms: number, name: string, job: () => Promise<number>) {
  let busy = false;
  const tick = async (retry = true) => {
    if (busy) return;
    busy = true;
    try {
      const n = await job();
      console.log(`${new Date().toISOString()} ${name}: ${n} rows`);
    } catch (err) {
      console.error(`${new Date().toISOString()} ${name}: ${err instanceof Error ? err.message : err}`);
      if (retry) setTimeout(() => void tick(false), RETRY_MS);
    } finally {
      busy = false;
    }
  };
  void tick();
  setInterval(() => void tick(), ms);
}

mkdirSync(OUT_DIR, { recursive: true });
hour = new Date().toISOString().slice(0, 13);
await gzipDone();
console.log(`Recording MTS feeds to ${OUT_DIR}`);
every(POSITIONS_EVERY_MS, "fixes", recordPositions);
every(PREDICTIONS_EVERY_MS, "predictions", recordPredictions);
