import type { MeasuredPath } from "./liveTransit.ts";
import type { LngLat } from "./types.ts";

/**
 * When a bus actually reached its stops, from its GPS fixes: the ground truth that arrival
 * predictions are scored against (scripts/prediction). Everything is measured along the trip's
 * route shape, so a bus is one number: meters from the start of its trip.
 */

/** A point this close to the route is on it. */
const NEAR_M = 40;

/**
 * Where a point falls along a path (meters from the start) and how far off the path it is, looking from `from`
 * meters on: the first stretch of the path that passes within NEAR_M of it, where it comes closest. A loop that
 * ends where it starts passes its first stop twice; a bus gets there the first time. Where no stretch comes
 * that close, the nearest point anywhere ahead.
 */
export function snapAlong(path: MeasuredPath, p: LngLat, from = 0): { along: number; off: number } {
  const { points, at } = path;
  const kx = Math.cos((p[1] * Math.PI) / 180) * 111_320;
  const ky = 110_540;
  let best = { along: Math.max(0, Math.min(from, path.length)), off: Infinity };
  let near: { along: number; off: number } | null = null;
  for (let k = 1; k < points.length; k++) {
    if (at[k] < from) continue;
    const [a, b] = [points[k - 1], points[k]];
    const [ax, ay, bx, by, px, py] = [a[0] * kx, a[1] * ky, b[0] * kx, b[1] * ky, p[0] * kx, p[1] * ky];
    const [dx, dy] = [bx - ax, by - ay];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const along = at[k - 1] + t * (at[k] - at[k - 1]);
    if (along < from) continue;
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (off < best.off) best = { along, off };
    if (off <= NEAR_M) {
      if (!near || off < near.off) near = { along, off };
    } else if (near) return near; // past the first close stretch
  }
  return near ?? best;
}

/** Each stop's distance along the path, in order: each searched from the one before, so a loop doesn't confuse them. */
export function stopDistances(path: MeasuredPath, stops: LngLat[]): number[] {
  let from = 0;
  return stops.map((s) => (from = snapAlong(path, s, from).along));
}

export interface Progress {
  /** When the fix was taken (ms). */
  t: number;
  /** Meters along the trip. */
  along: number;
}

/** A fix further than this from the route is a bad reading (or a detour), not progress. */
const OFF_ROUTE_M = 60;
/** GPS jitter can put a fix a little behind the last one; search back this far. */
const LOOK_BACK_M = 150;

/** A vehicle's fixes on one trip as progress along it: only forward, bad readings dropped. */
export function tripProgress(path: MeasuredPath, fixes: { t: number; lngLat: LngLat }[]): Progress[] {
  const out: Progress[] = [];
  for (const f of [...fixes].sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (last && f.t <= last.t) continue;
    const snap = snapAlong(path, f.lngLat, last ? Math.max(0, last.along - LOOK_BACK_M) : 0);
    if (snap.off > OFF_ROUTE_M) continue;
    out.push({ t: f.t, along: last ? Math.max(last.along, snap.along) : snap.along });
  }
  return out;
}

export interface ReachOptions {
  /** A bus has reached a stop this many meters before it: pulled up at the sign. */
  before?: number;
  /** Fixes further apart than this can't place the moment well; no answer instead (ms). */
  maxGap?: number;
}

/**
 * When the vehicle reached each stop (ms), or undefined: the moment its progress crossed a point just
 * before the stop, between the two fixes either side. Undefined where it was already past when the
 * fixes start, hasn't got there yet, or the fixes either side are too far apart.
 */
export function reachedTimes(progress: Progress[], stopAlongs: number[], opts: ReachOptions = {}): (number | undefined)[] {
  const before = opts.before ?? 15;
  const maxGap = opts.maxGap ?? 120_000;
  return stopAlongs.map((d) => {
    const mark = Math.max(0, d - before);
    if (!progress.length || progress[0].along >= mark) return undefined;
    for (let i = 1; i < progress.length; i++) {
      const [a, b] = [progress[i - 1], progress[i]];
      if (b.along < mark) continue;
      if (b.t - a.t > maxGap) return undefined;
      return a.t + ((mark - a.along) / (b.along - a.along)) * (b.t - a.t);
    }
    return undefined;
  });
}
