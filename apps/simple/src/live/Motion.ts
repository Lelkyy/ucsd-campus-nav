import { measurePath, pointAlong, snapAlong, type LiveVehicle, type LngLat, type MeasuredPath, type TransitNetwork } from "@campus/core";

/**
 * Keeps buses and trolleys moving between GPS fixes. MTS's fixes come about every 30 s and are already 30–60 s
 * old, so a vehicle drawn at its fix sits still, then jumps.
 *
 * Mainly it follows the arrival model (scripts/prediction/live.ts, `settings.modelUrl`): for each bus, a path
 * from its last fix through its next stops, each at the time the model predicts the bus gets there. The bus is
 * drawn where that path says it is now, so it slows where the model expects a hold-up and keeps pace where it
 * doesn't, and gets more accurate as the model learns.
 *
 * Without the model (no server, or a bus it doesn't cover): along its route at the speed it has been going, for
 * up to two minutes past its fix; off the routes we have shapes for, in a straight line, briefly.
 *
 * Either way, new information eases the bus to its new spot rather than teleporting it.
 */

/** A bus's path from the model: [lng, lat, time (s)], times rising. */
export type TimedPath = [number, number, number][];

/** Keep moving at most this long past the fix along a route (ms). */
const ALONG_ROUTE_MS = 120_000;
/** Off a known route, in a straight line, at most this long (ms). */
const STRAIGHT_MS = 45_000;
/** A fix this close to a route's shape is on it (m). */
const ON_ROUTE_M = 40;
/** A new fix eases the vehicle from where it was drawn over this long (ms). */
const EASE_MS = 1500;
/** Faster than this between fixes is a GPS jump, not driving (m/s). */
const MAX_SPEED = 25;
/** Fixes further apart than this don't give a speed (ms). */
const MAX_GAP_MS = 300_000;

interface Track {
  vehicle: LiveVehicle;
  /** The route shape it's on, and how far along it the last fix was (m). */
  path?: MeasuredPath;
  along: number;
  /** Along the route (m/s). */
  speed: number;
  /** Off a known route: degrees per ms, east and north. */
  velocity?: [number, number];
  /** The model's path for it, when there is one. */
  plan?: TimedPath;
  /** Where it was drawn when the new fix or path came, to ease from. */
  easeFrom?: LngLat;
  easeAt: number;
}

export class VehicleMotion {
  private readonly paths = new Map<string, MeasuredPath[]>();
  private readonly tracks = new Map<string, Track>();

  constructor(transit: TransitNetwork) {
    const seen = new Set<unknown>();
    for (const pattern of transit.data.patterns) {
      const route = transit.data.routes[pattern.route];
      if (!route || pattern.shape.length < 2 || seen.has(pattern.shape)) continue;
      seen.add(pattern.shape);
      const list = this.paths.get(route.short) ?? [];
      list.push(measurePath(pattern.shape));
      this.paths.set(route.short, list);
    }
  }

  /** The model's latest paths, by vehicle id. A path older than the vehicle's newest fix is ignored. */
  setPaths(paths: Map<string, TimedPath>, now = Date.now()) {
    for (const [id, t] of this.tracks) {
      const plan = paths.get(id);
      const usable = plan && plan.length > 1 && plan[0][2] * 1000 >= t.vehicle.fixAt - 30_000 ? plan : undefined;
      if (usable === t.plan) continue;
      t.easeFrom = this.position(t, now);
      t.easeAt = now;
      t.plan = usable;
    }
  }

  /** The latest fixes from the feed. */
  update(vehicles: LiveVehicle[], now = Date.now()) {
    const ids = new Set<string>();
    for (const v of vehicles) {
      ids.add(v.id);
      const old = this.tracks.get(v.id);
      if (old && old.vehicle.fixAt === v.fixAt) {
        old.vehicle = { ...v, lngLat: old.vehicle.lngLat };
        continue;
      }
      const shown = old ? this.position(old, now) : undefined;
      const dt = old ? v.fixAt - old.vehicle.fixAt : 0;
      const track: Track = {
        vehicle: v,
        along: 0,
        speed: 0,
        easeAt: now,
        ...(shown ? { easeFrom: shown } : {}),
        ...(old?.plan && old.plan[0][2] * 1000 >= v.fixAt - 30_000 ? { plan: old.plan } : {}),
      };
      // The route shape it's on: near this fix (and the last one), moving forward along it.
      let best: { path: MeasuredPath; along: number; off: number; prev?: number } | undefined;
      for (const path of this.paths.get(v.route) ?? []) {
        const now_ = snapAlong(path, v.lngLat, old?.path === path ? Math.max(0, old.along - 150) : 0);
        if (now_.off > ON_ROUTE_M) continue;
        const prev = old ? snapAlong(path, old.vehicle.lngLat, 0) : undefined;
        if (prev && prev.off <= ON_ROUTE_M && now_.along < prev.along - 10) continue; // this shape runs the other way
        const off = now_.off - (old?.path === path ? 15 : 0);
        if (!best || off < best.off) best = { path, along: now_.along, off, ...(prev && prev.off <= ON_ROUTE_M ? { prev: prev.along } : {}) };
      }
      if (best) {
        track.path = best.path;
        track.along = best.along;
        if (best.prev !== undefined && dt > 5_000 && dt < MAX_GAP_MS) {
          const v1 = Math.min(MAX_SPEED, Math.max(0, (best.along - best.prev) / (dt / 1000)));
          // Smooth a little: half the last speed, half this one.
          track.speed = old?.path === best.path ? (old.speed + v1) / 2 : v1;
        }
      } else if (old && dt > 5_000 && dt < MAX_GAP_MS) {
        const velocity: [number, number] = [(v.lngLat[0] - old.vehicle.lngLat[0]) / dt, (v.lngLat[1] - old.vehicle.lngLat[1]) / dt];
        const mps = Math.hypot(velocity[0] * 93_000, velocity[1] * 111_000) * 1000;
        if (mps > 1 && mps < MAX_SPEED) track.velocity = velocity;
      }
      this.tracks.set(v.id, track);
    }
    for (const id of this.tracks.keys()) if (!ids.has(id)) this.tracks.delete(id);
  }

  /** Every vehicle where it most likely is now, heading the way it's going. */
  positions(now = Date.now()): LiveVehicle[] {
    return [...this.tracks.values()].map((t) => {
      const lngLat = this.position(t, now);
      const heading = t.plan ? planHeading(t.plan, now / 1000) ?? t.vehicle.heading : t.path && t.speed > 0.5 ? pointAlong(t.path, this.along(t, now)).heading : t.vehicle.heading;
      return { ...t.vehicle, lngLat, ...(heading !== undefined ? { heading } : {}) };
    });
  }

  private along(t: Track, now: number): number {
    const dt = Math.min(ALONG_ROUTE_MS, Math.max(0, now - t.vehicle.fixAt));
    return Math.min(t.path?.length ?? 0, t.along + (t.speed * dt) / 1000);
  }

  private position(t: Track, now: number): LngLat {
    let at: LngLat = t.vehicle.lngLat;
    if (t.plan) at = planAt(t.plan, now / 1000);
    else if (t.path && t.speed > 0) at = pointAlong(t.path, this.along(t, now)).lngLat;
    else if (t.velocity) {
      const dt = Math.min(STRAIGHT_MS, Math.max(0, now - t.vehicle.fixAt));
      at = [t.vehicle.lngLat[0] + t.velocity[0] * dt, t.vehicle.lngLat[1] + t.velocity[1] * dt];
    }
    if (!t.easeFrom) return at;
    const k = Math.min(1, (now - t.easeAt) / EASE_MS);
    if (k >= 1) {
      delete t.easeFrom;
      return at;
    }
    return [t.easeFrom[0] + (at[0] - t.easeFrom[0]) * k, t.easeFrom[1] + (at[1] - t.easeFrom[1]) * k];
  }
}

/** Where a timed path puts the bus at `t` (s): at its start before, its end after, between points in between. */
function planAt(plan: TimedPath, t: number): LngLat {
  if (t <= plan[0][2]) return [plan[0][0], plan[0][1]];
  for (let k = 1; k < plan.length; k++) {
    const [x0, y0, t0] = plan[k - 1];
    const [x1, y1, t1] = plan[k];
    if (t > t1) continue;
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
  }
  const end = plan[plan.length - 1];
  return [end[0], end[1]];
}

/** The way a timed path is heading at `t` (degrees from north), while it's moving. */
function planHeading(plan: TimedPath, t: number): number | undefined {
  for (let k = 1; k < plan.length; k++) {
    if (t > plan[k][2] && k < plan.length - 1) continue;
    const [x0, y0] = plan[k - 1];
    const [x1, y1] = plan[k];
    if (x0 === x1 && y0 === y1) return undefined;
    const kx = Math.cos((y0 * Math.PI) / 180);
    return ((Math.atan2((x1 - x0) * kx, y1 - y0) * 180) / Math.PI + 360) % 360;
  }
  return undefined;
}
