/**
 * The arrival model, training on live data around the clock (packages/core/src/arrivalModel.ts).
 * Usage: npm run predict:live
 *
 * Follows the recorder's log files (scripts/record-mts.ts) as they're written, so it makes no requests of MTS:
 *   - every time MTS's predictions update (about once a minute), predicts every stop ahead of every active trip;
 *   - as buses reach stops (from their GPS fixes, packages/core/src/arrivals.ts), learns from the predictions
 *     made for them, once they've settled (learnAt);
 *   - on start, replays the last WARM_HOURS of recordings to warm up, then follows live.
 *
 * Writes to MODEL_DIR (default data/private/mts-model) every few minutes:
 *   model.json        everything learned (the weights, running averages and scores);
 *   predictions.json  the current prediction for every stop ahead of every active trip, with MTS's;
 *   scorecard.json    the last hour of settled predictions: our error vs MTS's, by horizon.
 * And logs the scorecard. Environment: LOG_DIR, MODEL_DIR, GTFS_ZIP, WARM_HOURS.
 */
process.env.TZ = "America/Los_Angeles";

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { learnAt, HORIZONS, OnlineArrivalModel, type ArrivalContext, type ArrivalPrediction } from "../../packages/core/src/arrivalModel.ts";
import { reachedTimes, stopDistances, tripProgress, type Progress } from "../../packages/core/src/arrivals.ts";
import { measurePath, type MeasuredPath } from "../../packages/core/src/liveTransit.ts";
import type { LngLat } from "../../packages/core/src/types.ts";
import { Timetable, tripSchedule, type StaticTrip } from "./gtfs.ts";

const ROOT = join(import.meta.dirname, "../..");
const LOG_DIR = process.env.LOG_DIR ?? join(ROOT, "data/private/mts-log");
const MODEL_DIR = process.env.MODEL_DIR ?? join(ROOT, "data/private/mts-model");
const GTFS = process.env.GTFS_ZIP ?? join(ROOT, "data/raw/gtfs/mts.zip");
const GTFS_URL = "https://www.sdmts.com/google_transit_files/google_transit.zip";
const WARM_HOURS = Number(process.env.WARM_HOURS ?? 48);

/** Predictions further ahead aren't made. */
const MAX_AHEAD_MS = 60 * 60_000;
/** A fix older than this doesn't say how late a bus is now. */
const STALE_FIX_MS = 5 * 60_000;
/** A trip whose predictions haven't moved for this long has left MTS's feed. */
const GONE_MS = 10 * 60_000;
/** Trips with nothing new for this long are forgotten. */
const FORGET_MS = 3 * 3600_000;
/** Share of predictions kept to learn from: thousands an hour, at a tenth of the memory. */
const LEARN_SHARE = 0.1;
/** How often to follow the log, check for a newer timetable, and write out (ms, wall clock). */
const TAIL_MS = 15_000;
const REFRESH_MS = 6 * 3600_000;
const WRITE_MS = 5 * 60_000;

interface Row { k: string; rx: number; t: number; v?: string; trip?: string; r?: string; stop?: string; arr?: number; lon?: number; lat?: number }
interface Point extends Progress { rx: number; delay: number }
interface Trip {
  id: string;
  route?: string;
  fixes: { t: number; rx: number; v?: string; lngLat: LngLat }[];
  preds: Map<string, { arr: number; t: number; rx: number; v?: string }>;
  lastPredRx: number;
  lastSeen: number;
  dirty: boolean;
  /** From the timetable, once loaded: route shape, stops along it, schedule, progress and arrivals. */
  timetable?: { stops: StaticTrip["stops"]; alongs: number[]; sched: number[]; schedAt: (a: number) => number; path: MeasuredPath };
  points: Point[];
  actual: (number | undefined)[];
}
interface Pending { trip: string; stop: number; c: ArrivalContext; p: ArrivalPrediction }

// Pick up where the last run left off; after a restart the warm-up replay rebuilds trips without learning twice.
const saved = existsSync(join(MODEL_DIR, "model.json")) && process.env.FRESH !== "1" ? JSON.parse(readFileSync(join(MODEL_DIR, "model.json"), "utf8")) : null;
const model = saved?.model ? OnlineArrivalModel.fromJSON(saved.model) : new OnlineArrivalModel();
/** Predictions made before this were learned from in an earlier run. */
const learnedUpTo: number = saved?.model ? (saved.now ?? 0) : 0;
const trips = new Map<string, Trip>();
/** Each bus's latest progress, on whatever trip it's running. */
const vehicles = new Map<string, { rx: number; t: number; delay: number; trip: string }>();
let timetable: Timetable;
const paths = new Map<string, MeasuredPath>();
let pending: Pending[] = [];
/** Settled predictions of the last hour: when, horizon, our error, MTS's error (s). */
let settled: { at: number; b: number; ours: number; mts: number }[] = [];
/** The data's clock: the latest time received. */
let now = 0;
let openPoll = 0;

// --- Timetable: downloaded weekly, held compactly.
let timetableAt = 0;
async function ensureGtfs() {
  const fresh = existsSync(GTFS) && Date.now() - statSync(GTFS).mtimeMs < 7 * 24 * 3600_000;
  if (!fresh) await download();
  const at = statSync(GTFS).mtimeMs;
  if (at !== timetableAt) {
    timetable = Timetable.load(GTFS);
    timetableAt = at;
    console.log(`Timetable: ${timetable.size.toLocaleString()} trips.`);
  }
}

async function download() {
  try {
    console.log("Downloading MTS's timetable ...");
    const res = await fetch(GTFS_URL, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mkdirSync(dirname(GTFS), { recursive: true });
    writeFileSync(`${GTFS}.tmp`, new Uint8Array(await res.arrayBuffer()));
    renameSync(`${GTFS}.tmp`, GTFS);
  } catch (err) {
    if (!existsSync(GTFS)) throw err;
    console.error(`Timetable refresh failed (${err instanceof Error ? err.message : err}); using the one we have.`);
  }
}

// --- Following the log.
function tripOf(id: string): Trip {
  let t = trips.get(id);
  if (!t) {
    t = { id, fixes: [], preds: new Map(), lastPredRx: 0, lastSeen: 0, dirty: false, points: [], actual: [] };
    trips.set(id, t);
  }
  return t;
}

function ingest(r: Row) {
  if (!r.trip) return;
  if (openPoll && r.rx !== openPoll) {
    predictAll(openPoll);
    openPoll = 0;
  }
  now = Math.max(now, r.rx);
  const t = tripOf(r.trip);
  t.lastSeen = r.rx;
  if (r.r) t.route = r.r;
  if (r.k === "fix" && r.lon !== undefined && r.lat !== undefined) {
    t.fixes.push({ t: r.t, rx: r.rx, v: r.v, lngLat: [r.lon, r.lat] });
    t.dirty = true;
  } else if (r.k === "pred" && r.stop && r.arr) {
    t.preds.set(r.stop, { arr: r.arr, t: r.t, rx: r.rx, v: r.v });
    t.lastPredRx = r.rx;
    openPoll = r.rx;
  }
}

/** Snap new fixes to the route; find which stops the bus has reached. */
function refresh(t: Trip) {
  if (!t.dirty) return;
  if (!t.fixes.length) return;
  if (!t.timetable) {
    const st = timetable.trip(t.id);
    if (!st) return;
    let path = paths.get(st.shapeId);
    if (!path) paths.set(st.shapeId, (path = measurePath(st.shape)));
    const alongs = stopDistances(path, st.stops.map((s) => s.lngLat));
    t.timetable = { stops: st.stops, alongs, path, ...tripSchedule(st, alongs, t.fixes[0].t) };
  }
  const { path, alongs, schedAt } = t.timetable;
  const byT = new Map(t.fixes.map((f) => [f.t, f]));
  t.points = tripProgress(path, t.fixes).map((p) => ({ ...p, rx: byT.get(p.t)?.rx ?? p.t, delay: (p.t - schedAt(p.along)) / 1000 }));
  t.actual = reachedTimes(t.points, alongs);
  const last = t.points[t.points.length - 1];
  const v = last && byT.get(last.t)?.v;
  if (v && (vehicles.get(v)?.rx ?? 0) <= last.rx) vehicles.set(v, { rx: last.rx, t: last.t, delay: last.delay, trip: t.id });
  t.dirty = false;
}

/** MTS's predictions just updated: predict every stop ahead of every active trip. */
const served = new Map<string, { route?: string; mts: number; at: number; by: string }>();
function predictAll(tau: number) {
  served.clear();
  for (const t of trips.values()) {
    refresh(t);
    if (!t.timetable || tau - t.lastPredRx > GONE_MS) continue;
    const own = t.points.length ? t.points[t.points.length - 1] : undefined;
    const fresh = own && tau - own.t <= STALE_FIX_MS ? own : undefined;
    t.timetable.stops.forEach((stop, i) => {
      if (i === 0 || t.actual[i] !== undefined) return;
      const pred = t.preds.get(stop.stopId);
      if (!pred || pred.arr - tau > MAX_AHEAD_MS || pred.arr < tau - 120_000) return;
      let vehicleDelay: number | undefined;
      let fixAge = fresh ? (tau - fresh.t) / 1000 : undefined;
      if (!fresh && pred.v) {
        const elsewhere = vehicles.get(pred.v);
        if (elsewhere && elsewhere.trip !== t.id && tau - elsewhere.t <= STALE_FIX_MS) {
          vehicleDelay = elsewhere.delay;
          fixAge = (tau - elsewhere.t) / 1000;
        }
      }
      const c: ArrivalContext = {
        tau,
        mts: pred.arr,
        schedule: t.timetable!.sched[i],
        route: t.route ?? "",
        stop: stop.stopId,
        ...(fresh ? { tripDelay: fresh.delay } : {}),
        ...(vehicleDelay !== undefined ? { vehicleDelay } : {}),
        ...(fixAge !== undefined ? { fixAge } : {}),
        predAge: (tau - pred.t) / 1000,
      };
      const p = model.predict(c);
      served.set(`${t.id}|${stop.stopId}`, { route: t.route, mts: pred.arr, at: p.at, by: p.by });
      if (keep(`${t.id}|${stop.stopId}|${tau}`)) pending.push({ trip: t.id, stop: i, c, p });
    });
  }
}

/** A fixed quarter of predictions, chosen by a hash of what they are. */
function keep(key: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32 < LEARN_SHARE;
}

/** Learn from every prediction that has settled; forget trips and predictions long gone. */
function learnDue() {
  for (const t of trips.values()) refresh(t);
  const still: Pending[] = [];
  for (const q of pending) {
    const actual = trips.get(q.trip)?.actual[q.stop];
    if (actual !== undefined && learnAt(q.c, actual) <= now) {
      if (q.c.tau <= learnedUpTo) continue;
      model.learn(q.c, q.p, actual);
      settled.push({ at: now, b: bucketOf((q.c.mts - q.c.tau) / 60_000), ours: Math.abs(q.p.at - actual) / 1000, mts: Math.abs(q.c.mts - actual) / 1000 });
    } else if (now - q.c.tau < FORGET_MS) still.push(q);
  }
  pending = still;
  settled = settled.filter((s) => now - s.at <= 3600_000);
  for (const [id, t] of trips) if (now - t.lastSeen > FORGET_MS) trips.delete(id);
}

const bucketOf = (ahead: number) => {
  for (let b = HORIZONS.length - 1; b > 0; b--) if (ahead >= HORIZONS[b - 1]) return b - 1;
  return 0;
};

function scorecard() {
  const rows = HORIZONS.slice(1).map((_, b) => {
    const s = settled.filter((x) => x.b === b);
    const mean = (k: "ours" | "mts") => Math.round(s.reduce((a, x) => a + x[k], 0) / (s.length || 1));
    return { horizon: `${HORIZONS[b]}-${HORIZONS[b + 1]} min`, settled: s.length, ourMeanError: mean("ours"), mtsMeanError: mean("mts") };
  });
  return { at: new Date(now).toISOString(), learnedFrom: model.learned, activeTrips: trips.size, waitingToLearn: pending.length, lastHour: rows, choosing: model.scores() };
}

function writeOut() {
  mkdirSync(MODEL_DIR, { recursive: true });
  const put = (name: string, value: unknown) => {
    writeFileSync(join(MODEL_DIR, `${name}.tmp`), JSON.stringify(value));
    renameSync(join(MODEL_DIR, `${name}.tmp`), join(MODEL_DIR, name));
  };
  const card = scorecard();
  put("model.json", { now, model: model.toJSON() });
  put("scorecard.json", card);
  put("predictions.json", { at: new Date(now).toISOString(), stops: Object.fromEntries(served) });
  const line = card.lastHour.filter((r) => r.settled).map((r) => `${r.horizon}: ours ${r.ourMeanError}s vs MTS ${r.mtsMeanError}s (${r.settled})`).join("; ");
  const mb = (n: number) => Math.round(n / 2 ** 20);
  const mem = process.memoryUsage();
  console.log(`${card.at} learned ${card.learnedFrom.toLocaleString()}, ${card.activeTrips} trips, ${card.waitingToLearn.toLocaleString()} waiting, memory ${mb(mem.heapUsed)} MB used, ${mb(mem.rss)} MB held. Last hour: ${line || "nothing settled yet"}`);
}

// --- Reading the log files.
const hourOf = (name: string) => Date.parse(`${name.slice(0, 13)}:00:00Z`);
function linesOf(text: string, cb: (r: Row) => void) {
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      cb(JSON.parse(line));
    } catch {
      /* a line cut off mid-write */
    }
  }
}

async function main() {
  await ensureGtfs();
  // Warm up: replay recent hours, learning as if live.
  const cutoff = Date.now() - WARM_HOURS * 3600_000;
  const files = readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d\d-\d\dT\d\d\.ndjson(\.gz)?$/.test(f) && hourOf(f) >= cutoff).sort();
  const current = files.filter((f) => f.endsWith(".ndjson")).pop();
  console.log(`Warming up on ${files.length} hours of recordings ...`);
  const read = (f: string) => (f.endsWith(".gz") ? gunzipSync(readFileSync(join(LOG_DIR, f))).toString("utf8") : readFileSync(join(LOG_DIR, f), "utf8"));
  const past = files.filter((f) => f !== current);
  let tick = 0;
  const replay = (r: Row) => {
    ingest(r);
    if (r.rx - tick >= 15_000) (learnDue(), (tick = r.rx));
  };
  for (const f of past) linesOf(read(f), replay);
  // The hour being written now: replay to its end, then follow it.
  let file = current ? join(LOG_DIR, current) : "";
  let offset = 0;
  let partial = "";
  const follow = () => {
    const latest = readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d\d-\d\dT\d\d\.ndjson$/.test(f)).sort().pop();
    const files = [file, latest ? join(LOG_DIR, latest) : ""].filter((f, i, a) => f && a.indexOf(f) === i);
    for (const f of files) {
      if (f !== file) (file = f), (offset = 0), (partial = "");
      let text = "";
      if (existsSync(f)) {
        const size = statSync(f).size;
        if (size > offset) {
          const fd = openSync(f, "r");
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          closeSync(fd);
          text = buf.toString("utf8");
          offset = size;
        }
      } else if (existsSync(`${f}.gz`)) {
        // Gzipped since we last read it: whatever was written after our place.
        const all = gunzipSync(readFileSync(`${f}.gz`));
        text = all.subarray(offset).toString("utf8");
        offset = all.length;
      }
      text = partial + text;
      const cut = text.lastIndexOf("\n");
      partial = text.slice(cut + 1);
      linesOf(text.slice(0, cut + 1), ingest);
    }
    learnDue();
  };
  follow();
  console.log(`Warmed up: learned from ${model.learned.toLocaleString()} predictions. Following ${LOG_DIR}.`);
  writeOut();
  setInterval(follow, TAIL_MS);
  setInterval(() => ensureGtfs().catch((e) => console.error(String(e))), REFRESH_MS);
  setInterval(writeOut, WRITE_MS);
}

await main();
