/**
 * Scores bus arrival predictions against when the buses actually arrived, from the recordings
 * (scripts/record-mts.ts). Usage: npx tsx scripts/prediction/evaluate.ts [log dir]
 *
 * 1. Truth: each trip's GPS fixes, snapped to its route shape from MTS's timetable (data/raw/gtfs/mts.zip),
 *    give the moment it reached each stop (packages/core/src/arrivals.ts).
 * 2. Replay: at every minute the recorder polled MTS, for every stop a trip hadn't reached yet,
 *    each method predicts the arrival using only what had been received by then.
 * 3. Methods are fitted on the earlier trips and scored on the later ones, by how far ahead MTS's prediction was.
 *
 * Methods:
 *   mts        MTS's own prediction, as published.
 *   schedule   The timetable.
 *   delay      The timetable plus how late the bus is now (from its latest fix against the schedule).
 *   mts+bias   MTS's prediction plus its typical error at that horizon.
 *   blend      MTS's prediction moved toward `delay` by a weight fitted per horizon, plus a bias.
 */
process.env.TZ = "America/Los_Angeles";

import { createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { measurePath } from "../../packages/core/src/liveTransit.ts";
import { reachedTimes, stopDistances, tripProgress } from "../../packages/core/src/arrivals.ts";
import type { LngLat } from "../../packages/core/src/types.ts";
import { loadTrips } from "./gtfs.ts";

const ROOT = join(import.meta.dirname, "../..");
const LOG_DIR = process.argv[2] ?? join(ROOT, "data/private/mts-log");
const GTFS = join(ROOT, "data/raw/gtfs/mts.zip");
/** Predictions are scored up to this far ahead. */
const MAX_AHEAD_MS = 60 * 60_000;
/** The latest fix is too old to say how late the bus is. */
const STALE_FIX_MS = 5 * 60_000;
/** Share of trips (the earliest) the methods are fitted on. */
const TRAIN_SHARE = 0.6;
/** Horizons scored separately, in minutes ahead (by MTS's prediction). */
const BUCKETS = [0, 2, 5, 10, 20, 60];

// --- 1. Read the recordings.
interface Fix { t: number; rx: number; lngLat: LngLat }
interface Pred { rx: number; arr: number }
const fixesByTrip = new Map<string, Fix[]>();
const predsByStop = new Map<string, Pred[]>();
const polls = new Set<number>();
let rowsRead = 0;
for (const name of readdirSync(LOG_DIR).filter((f) => /\.ndjson(\.gz)?$/.test(f)).sort()) {
  const stream = name.endsWith(".gz") ? createReadStream(join(LOG_DIR, name)).pipe(createGunzip()) : createReadStream(join(LOG_DIR, name));
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line) continue;
    let r: { k: string; rx: number; t: number; trip?: string; stop?: string; arr?: number; lon?: number; lat?: number };
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a line cut off when the recorder stopped
    }
    rowsRead++;
    if (!r.trip) continue;
    if (r.k === "fix" && r.lon !== undefined && r.lat !== undefined) {
      const list = fixesByTrip.get(r.trip) ?? [];
      list.push({ t: r.t, rx: r.rx, lngLat: [r.lon, r.lat] });
      fixesByTrip.set(r.trip, list);
    } else if (r.k === "pred" && r.stop && r.arr) {
      polls.add(r.rx);
      const key = `${r.trip}|${r.stop}`;
      const list = predsByStop.get(key) ?? [];
      list.push({ rx: r.rx, arr: r.arr });
      predsByStop.set(key, list);
    }
  }
}
const pollTimes = [...polls].sort((a, b) => a - b);
const predTrips = new Set([...predsByStop.keys()].map((k) => k.split("|")[0]));
const tripIds = new Set([...fixesByTrip.keys()].filter((t) => predTrips.has(t)));
console.log(`Read ${rowsRead.toLocaleString()} rows: ${fixesByTrip.size} trips with fixes, ${predTrips.size} with predictions, ${tripIds.size} with both.`);
if (pollTimes.length) console.log(`Recorded ${new Date(pollTimes[0]).toLocaleString()} to ${new Date(pollTimes[pollTimes.length - 1]).toLocaleString()}.`);

const timetable = loadTrips(GTFS, tripIds);
console.log(`${timetable.size} of them in MTS's timetable.`);

// --- 2. Truth and replay.
interface Sample {
  trip: string;
  /** When the prediction is made (ms). */
  tau: number;
  /** When the bus actually reached the stop (ms). */
  actual: number;
  mts: number;
  schedule: number;
  delay?: number;
  /** How far ahead MTS's prediction was, minutes. */
  ahead: number;
}
const samples: Sample[] = [];
let reached = 0;
const midnight = (t: number, daysBack: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
};

for (const [tripId, trip] of timetable) {
  const fixes = fixesByTrip.get(tripId)!;
  const path = measurePath(trip.shape);
  const alongs = stopDistances(path, trip.stops.map((s) => s.lngLat));
  const rxOf = new Map(fixes.map((f) => [f.t, f.rx]));
  const progress = tripProgress(path, fixes).map((p) => ({ ...p, rx: rxOf.get(p.t) ?? p.t }));
  const actuals = reachedTimes(progress, alongs);
  // The service day: whichever midnight puts the first scheduled stop nearest the first fix.
  const first = Math.min(...fixes.map((f) => f.t));
  const base = [0, 1].map((k) => midnight(first, k)).sort((a, b) => Math.abs(a + trip.stops[0].sched * 1000 - first) - Math.abs(b + trip.stops[0].sched * 1000 - first))[0];
  const sched = trip.stops.map((s) => base + s.sched * 1000);
  /** Scheduled time at a point along the trip, between the stops either side. */
  const schedAt = (along: number) => {
    if (along <= alongs[0]) return sched[0];
    for (let k = 1; k < alongs.length; k++) {
      if (along > alongs[k]) continue;
      const span = alongs[k] - alongs[k - 1];
      return span > 0 ? sched[k - 1] + ((along - alongs[k - 1]) / span) * (sched[k] - sched[k - 1]) : sched[k];
    }
    return sched[sched.length - 1];
  };

  trip.stops.forEach((stop, i) => {
    const actual = actuals[i];
    if (i === 0 || actual === undefined) return;
    reached++;
    const preds = (predsByStop.get(`${tripId}|${stop.stopId}`) ?? []).sort((a, b) => a.rx - b.rx);
    if (!preds.length) return;
    let p = -1;
    let f = -1;
    for (const tau of pollTimes) {
      if (tau < preds[0].rx || tau > actual - 30_000) continue;
      if (actual - tau > MAX_AHEAD_MS) continue;
      while (p + 1 < preds.length && preds[p + 1].rx <= tau) p++;
      while (f + 1 < progress.length && progress[f + 1].rx <= tau) f++;
      const mts = preds[p].arr;
      const fix = f >= 0 && tau - progress[f].t <= STALE_FIX_MS ? progress[f] : undefined;
      samples.push({
        trip: tripId,
        tau,
        actual,
        mts,
        schedule: sched[i],
        ...(fix ? { delay: sched[i] + (fix.t - schedAt(fix.along)) } : {}),
        ahead: (mts - tau) / 60_000,
      });
    }
  });
}
console.log(`Buses seen reaching ${reached.toLocaleString()} stops; ${samples.length.toLocaleString()} predictions to score.`);
if (process.env.WORST) {
  const worst = samples.filter((s) => s.ahead < 2).sort((x, y) => Math.abs(y.mts - y.actual) - Math.abs(x.mts - x.actual));
  const seen = new Set<string>();
  for (const s of worst) {
    const key = `${s.trip}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const trip = timetable.get(s.trip)!;
    console.log(`trip ${s.trip} route ${trip.routeId}: at ${new Date(s.tau).toLocaleTimeString()} MTS said ${new Date(s.mts).toLocaleTimeString()}, reached ${new Date(s.actual).toLocaleTimeString()} (${Math.round((s.actual - s.mts) / 60_000)} min later), schedule ${new Date(s.schedule).toLocaleTimeString()}`);
    if (seen.size >= Number(process.env.WORST)) break;
  }
}
if (!samples.length) process.exit(0);

// --- 3. Fit on the earlier trips, score on the later ones.
const tripStart = new Map<string, number>();
for (const s of samples) tripStart.set(s.trip, Math.min(tripStart.get(s.trip) ?? Infinity, s.tau));
const order = [...tripStart.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
const trainTrips = new Set(order.slice(0, Math.floor(order.length * TRAIN_SHARE)));
const train = samples.filter((s) => trainTrips.has(s.trip));
const test = samples.filter((s) => !trainTrips.has(s.trip));

const bucketOf = (ahead: number) => {
  for (let b = BUCKETS.length - 1; b > 0; b--) if (ahead >= BUCKETS[b - 1]) return b - 1;
  return 0;
};
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// mts+bias: MTS's median error per horizon.
const bias = BUCKETS.slice(1).map((_, b) => median(train.filter((s) => bucketOf(s.ahead) === b).map((s) => s.actual - s.mts)));
// blend: actual − mts ≈ c + w · (delay − mts), least squares per horizon.
const blend = BUCKETS.slice(1).map((_, b) => {
  const xs = train.filter((s) => bucketOf(s.ahead) === b && s.delay !== undefined);
  if (xs.length < 30) return { c: bias[b], w: 0 };
  const x = xs.map((s) => s.delay! - s.mts);
  const y = xs.map((s) => s.actual - s.mts);
  const mx = x.reduce((a, v) => a + v, 0) / x.length;
  const my = y.reduce((a, v) => a + v, 0) / y.length;
  const sxx = x.reduce((a, v) => a + (v - mx) ** 2, 0);
  const w = sxx ? Math.max(0, Math.min(1, x.reduce((a, v, k) => a + (v - mx) * (y[k] - my), 0) / sxx)) : 0;
  return { c: my - w * mx, w };
});

const methods: Record<string, (s: Sample) => number> = {
  mts: (s) => s.mts,
  schedule: (s) => s.schedule,
  delay: (s) => s.delay ?? s.mts,
  "mts+bias": (s) => s.mts + bias[bucketOf(s.ahead)],
  blend: (s) => {
    const { c, w } = blend[bucketOf(s.ahead)];
    return s.mts + c + (s.delay !== undefined ? w * (s.delay - s.mts) : 0);
  },
};

console.log(`\nFitted on ${train.length.toLocaleString()} predictions (${trainTrips.size} trips); scored on ${test.length.toLocaleString()} (${order.length - trainTrips.size} later trips).`);
console.log("Error in seconds: typical (median), mean, 90% of predictions within; bias = how late the prediction is on average; ≤1 min = share within a minute.\n");
const pad = (s: string | number, n: number) => String(s).padStart(n);
for (let b = -1; b < BUCKETS.length - 1; b++) {
  const set = b < 0 ? test : test.filter((s) => bucketOf(s.ahead) === b);
  if (!set.length) continue;
  console.log(b < 0 ? `All horizons (${set.length.toLocaleString()} predictions)` : `${BUCKETS[b]}–${BUCKETS[b + 1]} min ahead (${set.length.toLocaleString()})`);
  console.log(`  ${"method".padEnd(10)}${pad("median", 8)}${pad("mean", 8)}${pad("p90", 8)}${pad("bias", 8)}${pad("≤1 min", 9)}`);
  for (const [name, f] of Object.entries(methods)) {
    const err = set.map((s) => (f(s) - s.actual) / 1000);
    const abs = err.map(Math.abs).sort((a, c) => a - c);
    const mean = abs.reduce((a, v) => a + v, 0) / abs.length;
    const within = abs.filter((e) => e <= 60).length / abs.length;
    console.log(
      `  ${name.padEnd(10)}${pad(Math.round(median(abs)), 8)}${pad(Math.round(mean), 8)}${pad(Math.round(abs[Math.floor(abs.length * 0.9)]), 8)}${pad(Math.round(err.reduce((a, v) => a + v, 0) / err.length), 8)}${pad(`${Math.round(within * 100)}%`, 9)}`,
    );
  }
  console.log("");
}
