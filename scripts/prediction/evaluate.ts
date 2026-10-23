/**
 * Scores bus arrival predictions against when the buses actually arrived, from the recordings
 * (scripts/record-mts.ts). Usage: npm run evaluate:prediction [-- log dir]
 * WORST=10 also lists the trips MTS got most wrong at 0–2 minutes ahead, to check the truth by hand.
 *
 * 1. Truth: each trip's GPS fixes, snapped to its route shape from MTS's timetable (data/raw/gtfs/mts.zip),
 *    give the moment it reached each stop (packages/core/src/arrivals.ts).
 * 2. Replay in time order, as it would run live: at every minute the recorder polled MTS, every method predicts
 *    each stop a trip hadn't reached yet, from only what had been received by then. The online model learns from
 *    each prediction only once that bus has reached that stop.
 * 3. Scored on the later trips; the fixed methods are fitted on the earlier ones.
 *
 * Methods:
 *   mts        MTS's own prediction, as published.
 *   schedule   The timetable.
 *   delay      The timetable plus how late the bus is now (from its latest fix against the schedule).
 *   mts+bias   MTS's prediction plus its typical error at that horizon, fitted once on the earlier trips.
 *   online     packages/core/src/arrivalModel.ts, learning from every arrival as it happens.
 */
process.env.TZ = "America/Los_Angeles";

import { createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { measurePath } from "../../packages/core/src/liveTransit.ts";
import { reachedTimes, stopDistances, tripProgress } from "../../packages/core/src/arrivals.ts";
import { HORIZONS, learnAt, OnlineArrivalModel, type ArrivalContext, type ArrivalPrediction } from "../../packages/core/src/arrivalModel.ts";
import type { LngLat } from "../../packages/core/src/types.ts";
import { loadTrips, tripSchedule } from "./gtfs.ts";

const ROOT = join(import.meta.dirname, "../..");
const LOG_DIR = process.argv[2] ?? join(ROOT, "data/private/mts-log");
const GTFS = join(ROOT, "data/raw/gtfs/mts.zip");
/** Predictions are scored up to this far ahead. */
const MAX_AHEAD_MS = 60 * 60_000;
/** The latest fix is too old to say how late the bus is. */
const STALE_FIX_MS = 5 * 60_000;
/** Share of trips (the earliest) the fixed methods are fitted on; the rest are scored. */
const TRAIN_SHARE = 0.6;

// --- 1. Read the recordings.
interface Fix { t: number; rx: number; v?: string; lngLat: LngLat }
interface Pred { rx: number; t: number; v?: string; arr: number }
const fixesByTrip = new Map<string, Fix[]>();
const predsByStop = new Map<string, Pred[]>();
const polls = new Set<number>();
let rowsRead = 0;
for (const name of readdirSync(LOG_DIR).filter((f) => /\.ndjson(\.gz)?$/.test(f)).sort()) {
  const stream = name.endsWith(".gz") ? createReadStream(join(LOG_DIR, name)).pipe(createGunzip()) : createReadStream(join(LOG_DIR, name));
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line) continue;
    let r: { k: string; rx: number; t: number; v?: string; trip?: string; stop?: string; arr?: number; lon?: number; lat?: number };
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a line cut off when the recorder stopped
    }
    rowsRead++;
    if (!r.trip) continue;
    if (r.k === "fix" && r.lon !== undefined && r.lat !== undefined) {
      const list = fixesByTrip.get(r.trip) ?? [];
      list.push({ t: r.t, rx: r.rx, v: r.v, lngLat: [r.lon, r.lat] });
      fixesByTrip.set(r.trip, list);
    } else if (r.k === "pred" && r.stop && r.arr) {
      polls.add(r.rx);
      const key = `${r.trip}|${r.stop}`;
      const list = predsByStop.get(key) ?? [];
      list.push({ rx: r.rx, t: r.t, v: r.v, arr: r.arr });
      predsByStop.set(key, list);
    }
  }
}
const pollTimes = [...polls].sort((a, b) => a - b);
const predTrips = new Set([...predsByStop.keys()].map((k) => k.split("|")[0]));
console.log(`Read ${rowsRead.toLocaleString()} rows: ${fixesByTrip.size} trips with fixes, ${predTrips.size} with predictions.`);
if (pollTimes.length) console.log(`Recorded ${new Date(pollTimes[0]).toLocaleString()} to ${new Date(pollTimes[pollTimes.length - 1]).toLocaleString()}.`);

// Every trip with fixes: the ones predicted, and the ones before them (how late a bus is on its last trip).
const timetable = loadTrips(GTFS, new Set(fixesByTrip.keys()));
console.log(`${timetable.size} of the trips with fixes are in MTS's timetable.`);

// --- 2. Each trip's progress, how late it was at each fix, and when it reached each stop.
interface Point { t: number; rx: number; along: number; /** Seconds behind the timetable. */ delay: number }
interface TripState { routeId: string; stops: { stopId: string; sched: number; actual?: number }[]; points: Point[] }
const trips = new Map<string, TripState>();
/** Each bus's fixes on whatever trip it was running, in the order received. */
const byVehicle = new Map<string, { rx: number; t: number; delay: number; trip: string }[]>();
let reached = 0;

for (const [tripId, trip] of timetable) {
  const fixes = fixesByTrip.get(tripId)!;
  const path = measurePath(trip.shape);
  const alongs = stopDistances(path, trip.stops.map((s) => s.lngLat));
  const { sched, schedAt } = tripSchedule(trip, alongs, Math.min(...fixes.map((f) => f.t)));
  const byT = new Map(fixes.map((f) => [f.t, f]));
  const points = tripProgress(path, fixes).map((p) => ({ ...p, rx: byT.get(p.t)?.rx ?? p.t, delay: (p.t - schedAt(p.along)) / 1000 }));
  const actuals = reachedTimes(points, alongs);
  trips.set(tripId, { routeId: trip.routeId, stops: trip.stops.map((s, i) => ({ stopId: s.stopId, sched: sched[i], ...(i > 0 && actuals[i] !== undefined ? { actual: actuals[i] } : {}) })), points });
  reached += actuals.filter((a, i) => i > 0 && a !== undefined).length;
  for (const p of points) {
    const v = byT.get(p.t)?.v;
    if (!v) continue;
    const list = byVehicle.get(v) ?? [];
    list.push({ rx: p.rx, t: p.t, delay: p.delay, trip: tripId });
    byVehicle.set(v, list);
  }
}
for (const list of byVehicle.values()) list.sort((a, b) => a.rx - b.rx);

/** The latest entry received by `tau` (binary search on rx). */
const latest = <T extends { rx: number }>(list: T[], tau: number): T | undefined => {
  let [lo, hi] = [0, list.length - 1];
  let found: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].rx <= tau) (found = list[mid]), (lo = mid + 1);
    else hi = mid - 1;
  }
  return found;
};

// --- 3. What was known at each poll, for every stop a trip hadn't reached yet.
interface Sample { trip: string; c: ArrivalContext; actual: number; online?: ArrivalPrediction }
const samples: Sample[] = [];
for (const [tripId, state] of trips) {
  for (const stop of state.stops) {
    if (stop.actual === undefined) continue;
    const actual = stop.actual;
    const preds = (predsByStop.get(`${tripId}|${stop.stopId}`) ?? []).sort((a, b) => a.rx - b.rx);
    if (!preds.length) continue;
    for (const tau of pollTimes) {
      if (tau < preds[0].rx || tau > actual - 30_000 || actual - tau > MAX_AHEAD_MS) continue;
      const pred = latest(preds, tau)!;
      const own = latest(state.points, tau);
      const fresh = own && tau - own.t <= STALE_FIX_MS ? own : undefined;
      let vehicleDelay: number | undefined;
      let fixAge = fresh ? (tau - fresh.t) / 1000 : undefined;
      if (!fresh && pred.v) {
        const elsewhere = latest(byVehicle.get(pred.v) ?? [], tau);
        if (elsewhere && elsewhere.trip !== tripId && tau - elsewhere.t <= STALE_FIX_MS) {
          vehicleDelay = elsewhere.delay;
          fixAge = (tau - elsewhere.t) / 1000;
        }
      }
      samples.push({
        trip: tripId,
        actual,
        c: {
          tau,
          mts: pred.arr,
          schedule: stop.sched,
          route: state.routeId,
          stop: stop.stopId,
          ...(fresh ? { tripDelay: fresh.delay } : {}),
          ...(vehicleDelay !== undefined ? { vehicleDelay } : {}),
          ...(fixAge !== undefined ? { fixAge } : {}),
          predAge: (tau - pred.t) / 1000,
        },
      });
    }
  }
}
console.log(`Buses seen reaching ${reached.toLocaleString()} stops; ${samples.length.toLocaleString()} predictions to score.`);
if (!samples.length) process.exit(0);

if (process.env.WORST) {
  const worst = samples.filter((s) => s.c.mts - s.c.tau < 2 * 60_000).sort((x, y) => Math.abs(y.c.mts - y.actual) - Math.abs(x.c.mts - x.actual));
  const seen = new Set<string>();
  for (const s of worst) {
    if (seen.has(s.trip)) continue;
    seen.add(s.trip);
    const tm = (t: number) => new Date(t).toLocaleTimeString();
    console.log(`trip ${s.trip} route ${s.c.route}: at ${tm(s.c.tau)} MTS said ${tm(s.c.mts)}, reached ${tm(s.actual)} (${Math.round((s.actual - s.c.mts) / 60_000)} min later), schedule ${tm(s.c.schedule)}`);
    if (seen.size >= Number(process.env.WORST)) break;
  }
}

// --- 4. The online model, replayed in time order: predict at each poll, learn as each bus arrives.
samples.sort((a, b) => a.c.tau - b.c.tau);
// Each prediction is learned from once it settles (learnAt), not the moment its bus arrives.
const byArrival = [...samples].sort((a, b) => learnAt(a.c, a.actual) - learnAt(b.c, b.actual));
const model = new OnlineArrivalModel();
let next = 0;
for (const s of samples) {
  while (next < byArrival.length && learnAt(byArrival[next].c, byArrival[next].actual) <= s.c.tau) {
    const done = byArrival[next++];
    if (done.online) model.learn(done.c, done.online, done.actual);
  }
  s.online = model.predict(s.c);
}

// --- 5. Fixed methods, fitted on the earlier trips; everything scored on the later ones.
const tripStart = new Map<string, number>();
for (const s of samples) tripStart.set(s.trip, Math.min(tripStart.get(s.trip) ?? Infinity, s.c.tau));
const order = [...tripStart.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
const trainTrips = new Set(order.slice(0, Math.floor(order.length * TRAIN_SHARE)));
const train = samples.filter((s) => trainTrips.has(s.trip));
const test = samples.filter((s) => !trainTrips.has(s.trip));

const ahead = (s: Sample) => (s.c.mts - s.c.tau) / 60_000;
const bucketOf = (a: number) => {
  for (let b = HORIZONS.length - 1; b > 0; b--) if (a >= HORIZONS[b - 1]) return b - 1;
  return 0;
};
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const bias = HORIZONS.slice(1).map((_, b) => median(train.filter((s) => bucketOf(ahead(s)) === b).map((s) => s.actual - s.c.mts)));

const methods: Record<string, (s: Sample) => number> = {
  mts: (s) => s.c.mts,
  schedule: (s) => s.c.schedule,
  delay: (s) => (s.c.tripDelay !== undefined ? s.c.schedule + s.c.tripDelay * 1000 : s.c.mts),
  "mts+bias": (s) => s.c.mts + bias[bucketOf(ahead(s))],
  online: (s) => s.online!.at,
};

console.log(`\nScored on ${test.length.toLocaleString()} predictions (${order.length - trainTrips.size} later trips); mts+bias fitted on ${train.length.toLocaleString()} (${trainTrips.size} earlier trips); online learned from ${model.learned.toLocaleString()} as they arrived.`);
console.log("Error in seconds: typical (median), mean, 90% of predictions within; bias = how late the prediction is on average; ≤1 min = share within a minute.\n");
const pad = (s: string | number, n: number) => String(s).padStart(n);
for (let b = -1; b < HORIZONS.length - 1; b++) {
  const set = b < 0 ? test : test.filter((s) => bucketOf(ahead(s)) === b);
  if (!set.length) continue;
  console.log(b < 0 ? `All horizons (${set.length.toLocaleString()} predictions)` : `${HORIZONS[b]}–${HORIZONS[b + 1]} min ahead (${set.length.toLocaleString()})`);
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
if (process.env.WEIGHTS) console.log("Online model weights (minutes per unit):", model.weights());
console.log("What the online model serves at each horizon, by recent mean error in minutes:", model.scores());
