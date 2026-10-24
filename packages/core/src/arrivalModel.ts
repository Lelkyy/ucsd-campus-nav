/**
 * An arrival-time model that learns while it runs. It starts from MTS's own prediction and learns how far
 * off MTS is, from every bus that reaches a stop: each arrival scores every earlier prediction for that stop,
 * and the model updates right away. Two parts:
 *
 *  - Running averages of MTS's recent error, by route, by stop, and overall, fading with a half-life so
 *    "route 30 is running 4 minutes behind MTS right now" is picked up within minutes.
 *  - For each horizon (how far ahead MTS's prediction is), a small linear model over those averages and the
 *    live signals: how late this bus is now, how late the bus that will run this trip is on the trip it's still
 *    finishing, how stale MTS's prediction and the last GPS fix are. Fitted by recursive least squares with a
 *    forgetting factor, so it follows the day as it changes. Close-in and far-out predictions go wrong in
 *    different ways, so each horizon has its own.
 *
 * It also keeps score: for each horizon, how far off MTS as published, MTS plus the route's recent error, and the
 * full model have each been lately, against the buses that have since arrived. It serves whichever has been
 * closest, so where the full model isn't helping (far ahead, where it can only learn from buses an hour later)
 * it falls back by itself, and switches back when it starts winning.
 *
 * Everything is in minutes inside; times in and out are ms since the epoch.
 */

/** What's known about one stop of one trip at the moment of predicting. */
export interface ArrivalContext {
  /** Now (ms). */
  tau: number;
  /** MTS's predicted arrival (ms). */
  mts: number;
  /** The timetable's arrival (ms). */
  schedule: number;
  route: string;
  stop: string;
  /** How late this trip's bus is now, from its latest fix against the timetable (s). Undefined before the trip starts or with no fresh fix. */
  tripDelay?: number;
  /** How late the bus that will run this trip is on the trip it's still finishing (s), when it hasn't started this one. */
  vehicleDelay?: number;
  /** Age of the latest GPS fix behind tripDelay or vehicleDelay (s). */
  fixAge?: number;
  /** Age of MTS's prediction (s). */
  predAge: number;
}

/** Horizons (minutes ahead, by MTS's prediction), each with its own model. */
export const HORIZONS = [0, 2, 5, 10, 20, 60];
const NB = HORIZONS.length - 1;
const bucketOf = (ahead: number) => {
  for (let b = NB; b > 0; b--) if (ahead >= HORIZONS[b - 1]) return b - 1;
  return 0;
};

/** How long after its horizon's far end a prediction waits before it's learned from (ms). */
const SETTLE_MS = 5 * 60_000;

/**
 * When to learn from a prediction (ms): once the bus has arrived, and not before every bus predicted at that
 * moment and horizon has had time to. Learning from each bus the moment it arrives would learn from the early
 * ones first, the late ones still on the road, and the model would come to expect buses earlier than they come.
 */
export function learnAt(c: ArrivalContext, actual: number): number {
  const b = bucketOf((c.mts - c.tau) / 60_000);
  return Math.max(actual, c.tau + HORIZONS[b + 1] * 60_000 + SETTLE_MS);
}

/** The ways of predicting it chooses between, by how they've done lately. */
export const CANDIDATES = ["mts", "mts+route", "model"] as const;
export type Candidate = (typeof CANDIDATES)[number];

/** A prediction, with what it was made from (hand it back to `learn` once the bus arrives). */
export interface ArrivalPrediction {
  /** Predicted arrival (ms). */
  at: number;
  /** Which candidate it is. */
  by: Candidate;
  x: Float64Array;
  /** Each candidate's correction to MTS, in minutes. */
  corrections: Record<Candidate, number>;
}

/** Running mean of a residual that fades with time. */
interface Ewma {
  mean: number;
  weight: number;
  at: number;
}

export interface ModelOptions {
  /** Half-life of the route and overall averages (ms). */
  routeHalfLife?: number;
  /** Half-life of the per-stop averages (ms). */
  stopHalfLife?: number;
  /** Forgetting factor per update of each horizon's model: 1 − 1/(updates it remembers). */
  forget?: number;
  /** How far the weights may move from "trust MTS" before data backs it (prior variance). */
  prior?: number;
  /** Half-life of each candidate's recent score (ms). */
  scoreHalfLife?: number;
}

/** Feature names, in order (for reading the fitted weights). */
export const FEATURES = [
  "constant",
  "this bus's delay vs MTS",
  "has this bus's delay",
  "next bus still on its last trip: its delay vs MTS",
  "next bus still on its last trip",
  "MTS is just the timetable",
  "route's recent MTS error",
  "stop's recent MTS error",
  "overall recent MTS error",
  "GPS fix age",
  "MTS prediction age",
  "minutes ahead",
];
const D = FEATURES.length;

export class OnlineArrivalModel {
  private ewma = new Map<string, Ewma>();
  private theta: Float64Array[] = [];
  private P: Float64Array[] = [];
  private readonly routeHalfLife: number;
  private readonly stopHalfLife: number;
  private readonly forget: number;
  private readonly prior: number;
  private readonly scoreHalfLife: number;
  /** Predictions learned from (each arrival scores every earlier prediction for its stop). */
  learned = 0;

  constructor(opts: ModelOptions = {}) {
    this.routeHalfLife = opts.routeHalfLife ?? 30 * 60_000;
    this.stopHalfLife = opts.stopHalfLife ?? 3 * 3600_000;
    this.forget = opts.forget ?? 1 - 1 / 50_000;
    this.prior = opts.prior ?? 1;
    this.scoreHalfLife = opts.scoreHalfLife ?? 60 * 60_000;
    for (let b = 0; b < NB; b++) {
      this.theta.push(new Float64Array(D));
      const P = new Float64Array(D * D);
      for (let i = 0; i < D; i++) P[i * D + i] = this.prior;
      this.P.push(P);
    }
  }

  /** The running average under `key` as of `at`, pulled toward `prior` while it has little behind it. */
  private average(key: string, at: number, halfLife: number, prior: number, strength = 5): number {
    const e = this.ewma.get(key);
    if (!e) return prior;
    const w = e.weight * 2 ** (-Math.max(0, at - e.at) / halfLife);
    return (e.mean * w + prior * strength) / (w + strength);
  }

  private observe(key: string, at: number, halfLife: number, value: number) {
    const e = this.ewma.get(key) ?? { mean: 0, weight: 0, at };
    const w = e.weight * 2 ** (-Math.max(0, at - e.at) / halfLife) + 1;
    this.ewma.set(key, { mean: e.mean + (value - e.mean) / w, weight: w, at: Math.max(at, e.at) });
  }

  /** The model's inputs for a prediction (read from the running averages as they are now). */
  features(c: ArrivalContext): Float64Array {
    const ahead = (c.mts - c.tau) / 60_000;
    const b = bucketOf(ahead);
    const overall = this.average(`all|${b}`, c.tau, this.routeHalfLife, 0);
    return Float64Array.from([
      1,
      c.tripDelay !== undefined ? clamp((c.schedule + c.tripDelay * 1000 - c.mts) / 60_000, -30, 30) : 0,
      c.tripDelay !== undefined ? 1 : 0,
      c.vehicleDelay !== undefined ? clamp((c.schedule + c.vehicleDelay * 1000 - c.mts) / 60_000, -30, 60) : 0,
      c.vehicleDelay !== undefined ? 1 : 0,
      Math.abs(c.mts - c.schedule) < 30_000 ? 1 : 0,
      this.average(`route|${c.route}|${b}`, c.tau, this.routeHalfLife, overall),
      this.average(`stop|${c.route}|${c.stop}`, c.tau, this.stopHalfLife, overall),
      overall,
      clamp((c.fixAge ?? 0) / 60, 0, 10),
      clamp(c.predAge / 60, 0, 10),
      // Where in its horizon, 0 to 1.
      clamp((ahead - HORIZONS[b]) / (HORIZONS[b + 1] - HORIZONS[b]), 0, 1),
    ]);
  }

  /** The predicted arrival, from whichever candidate has been closest lately at this horizon. */
  predict(c: ArrivalContext): ArrivalPrediction {
    const x = this.features(c);
    const b = bucketOf((c.mts - c.tau) / 60_000);
    const theta = this.theta[b];
    let r = 0;
    for (let i = 0; i < D; i++) r += theta[i] * x[i];
    const corrections: Record<Candidate, number> = { mts: 0, "mts+route": x[6], model: clamp(r, -30, 60) };
    const by = this.best(b);
    return { at: Math.max(c.tau, c.mts + corrections[by] * 60_000), by, x, corrections };
  }

  /** The candidate with the smallest recent error at horizon `b`; MTS until there's enough to judge by. */
  private best(b: number): Candidate {
    let best: Candidate = "mts";
    let bestErr = Infinity;
    for (const k of CANDIDATES) {
      const e = this.ewma.get(`score|${k}|${b}`);
      if (!e || e.weight < 50) return "mts";
      if (e.mean < bestErr) (best = k), (bestErr = e.mean);
    }
    return best;
  }

  /** Each candidate's recent mean error (minutes) at each horizon. */
  scores(): Record<string, Record<Candidate, number>> {
    return Object.fromEntries(
      HORIZONS.slice(1).map((_, b) => [
        `${HORIZONS[b]}-${HORIZONS[b + 1]} min`,
        Object.fromEntries(CANDIDATES.map((k) => [k, Math.round((this.ewma.get(`score|${k}|${b}`)?.mean ?? NaN) * 100) / 100])) as Record<Candidate, number>,
      ]),
    );
  }

  /** The bus reached the stop at `actual`: learn from a prediction made earlier. Call it at `learnAt`, not before. */
  learn(c: ArrivalContext, p: ArrivalPrediction, actual: number) {
    const x = p.x;
    const residual = clamp((actual - c.mts) / 60_000, -30, 60);
    const b = bucketOf((c.mts - c.tau) / 60_000);
    for (const k of CANDIDATES) this.observe(`score|${k}|${b}`, actual, this.scoreHalfLife, Math.abs(residual - p.corrections[k]));
    this.observe(`all|${b}`, actual, this.routeHalfLife, residual);
    this.observe(`route|${c.route}|${b}`, actual, this.routeHalfLife, residual);
    this.observe(`stop|${c.route}|${c.stop}`, actual, this.stopHalfLife, residual);
    this.rls(b, x, residual);
    this.learned++;
  }

  /** One recursive least squares step for horizon `b`, with the error capped so one odd bus can't swing it. */
  private rls(b: number, x: Float64Array, y: number) {
    const [P, theta, forget] = [this.P[b], this.theta[b], this.forget];
    const Px = new Float64Array(D);
    for (let i = 0; i < D; i++) {
      let s = 0;
      for (let j = 0; j < D; j++) s += P[i * D + j] * x[j];
      Px[i] = s;
    }
    let denom = forget;
    for (let i = 0; i < D; i++) denom += x[i] * Px[i];
    let pred = 0;
    for (let i = 0; i < D; i++) pred += theta[i] * x[i];
    const err = clamp(y - pred, -5, 5);
    for (let i = 0; i < D; i++) theta[i] += (Px[i] / denom) * err;
    for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) P[i * D + j] = (P[i * D + j] - (Px[i] * Px[j]) / denom) / forget;
    // Directions the data doesn't move would grow without bound under forgetting: hold them at the prior.
    for (let i = 0; i < D; i++) {
      const v = P[i * D + i];
      if (v > this.prior) {
        const s = Math.sqrt(this.prior / v);
        for (let j = 0; j < D; j++) (P[i * D + j] *= s), (P[j * D + i] *= s);
      }
    }
  }

  /** The fitted weights for each horizon, by feature name. */
  weights(): Record<string, Record<string, number>> {
    return Object.fromEntries(
      this.theta.map((theta, b) => [`${HORIZONS[b]}-${HORIZONS[b + 1]} min`, Object.fromEntries(FEATURES.map((f, i) => [f, Math.round(theta[i] * 1000) / 1000]))]),
    );
  }

  /** Everything learned, to save and pick up again after a restart. */
  toJSON() {
    return { version: 2, learned: this.learned, theta: this.theta.map((t) => [...t]), P: this.P.map((p) => [...p]), ewma: [...this.ewma] };
  }

  static fromJSON(state: ReturnType<OnlineArrivalModel["toJSON"]>, opts: ModelOptions = {}): OnlineArrivalModel {
    const m = new OnlineArrivalModel(opts);
    if (state.version !== 2 || state.theta.length !== NB || state.theta[0].length !== D) return m;
    m.theta = state.theta.map((t) => Float64Array.from(t));
    m.P = state.P.map((p) => Float64Array.from(p));
    m.ewma = new Map(state.ewma);
    m.learned = state.learned;
    return m;
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
