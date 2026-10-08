import type { Step } from "./instructions.ts";
import type { LngLat } from "./types.ts";

const RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

/**
 * Follows a position along a route polyline: how far along it you are and how
 * far off it. Uses a local flat projection, which is plenty accurate on campus.
 */
export class RouteTracker {
  /** Meters from the start to each vertex. */
  readonly cum: number[];
  readonly total: number;
  private readonly xy: [number, number][];
  private readonly mPerDegLon: number;

  constructor(readonly coords: LngLat[]) {
    const lat0 = coords.length ? coords[0][1] : 0;
    this.mPerDegLon = M_PER_DEG_LAT * Math.cos(lat0 * RAD);
    this.xy = coords.map(([lon, lat]) => [lon * this.mPerDegLon, lat * M_PER_DEG_LAT]);
    this.cum = [0];
    for (let i = 1; i < this.xy.length; i++) {
      const [ax, ay] = this.xy[i - 1];
      const [bx, by] = this.xy[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(bx - ax, by - ay));
    }
    this.total = this.cum[this.cum.length - 1] ?? 0;
  }

  /**
   * Snap `p` onto the route. `after` (meters along) keeps the match from jumping
   * back to an earlier part of the route that passes nearby.
   */
  locate(p: LngLat, after = -Infinity): { along: number; offRoute: number; point: LngLat } {
    const px = p[0] * this.mPerDegLon;
    const py = p[1] * M_PER_DEG_LAT;
    let best = { along: 0, offRoute: Infinity, point: this.coords[0] ?? p };
    for (let i = 1; i < this.xy.length; i++) {
      if (this.cum[i] < after - 30) continue;
      const [ax, ay] = this.xy[i - 1];
      const [bx, by] = this.xy[i];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const x = ax + t * dx;
      const y = ay + t * dy;
      const d = Math.hypot(px - x, py - y);
      if (d < best.offRoute) {
        best = { along: this.cum[i - 1] + t * Math.sqrt(len2), offRoute: d, point: [x / this.mPerDegLon, y / M_PER_DEG_LAT] };
      }
    }
    return best;
  }

  /** Point at a distance along the route (for simulating a walk). */
  pointAt(along: number): LngLat {
    if (!this.coords.length) return [0, 0];
    const a = Math.max(0, Math.min(this.total, along));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < a) i++;
    const seg = this.cum[i] - this.cum[i - 1] || 1;
    const t = (a - this.cum[i - 1]) / seg;
    const [x0, y0] = this.coords[i - 1];
    const [x1, y1] = this.coords[i] ?? this.coords[i - 1];
    return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
  }
}

/** Index of the instruction you're currently on, given how far along the route you are. */
export function currentStepIndex(steps: Step[], along: number): number {
  let idx = 0;
  for (let i = 0; i < steps.length; i++) if (steps[i].along <= along + 3) idx = i;
  return idx;
}

/** "In 120 ft" / "In 0.2 mi", for spoken and on-screen distances. */
export function speakDistance(meters: number): string {
  const feet = meters * 3.28084;
  if (feet < 50) return "Now";
  if (feet < 1000) return `In ${Math.round(feet / 10) * 10} feet`;
  return `In ${(meters / 1609.344).toFixed(1)} miles`;
}
