import type { LngLat } from "@campus/core";

export interface PlanProjection {
  /** Lng/lat to drawing coordinates (north up, to scale). */
  xy: (p: LngLat) => [number, number];
  /** Drawing height for the given width. */
  height: number;
  /** Drawing units per meter. */
  scale: number;
  /** Width of the framed area in meters. */
  widthM: number;
  /** An SVG path for a closed ring. */
  ring: (ring: LngLat[]) => string;
}

/**
 * Frames some points in a drawing `width` wide with `pad` around them: a local
 * flat projection in meters, north up, the same scale both ways.
 */
export function fitProjection(points: LngLat[], width: number, pad: number, maxHeight = Infinity): PlanProjection {
  const lat0 = points.length ? points[0][1] : 0;
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110_574;
  const xs = points.map((p) => p[0] * mx);
  const ys = points.map((p) => -p[1] * my);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const widthM = Math.max(1, maxX - minX);
  const heightM = Math.max(1, maxY - minY);
  const scale = Math.min((width - 2 * pad) / Math.max(widthM, heightM), (maxHeight - 2 * pad) / heightM);
  const height = Math.round(heightM * scale + 2 * pad);
  const offX = (width - widthM * scale) / 2;
  const xy = ([lon, lat]: LngLat): [number, number] => [offX + (lon * mx - minX) * scale, pad + (-lat * my - minY) * scale];
  const ring = (r: LngLat[]) => r.map((p, i) => `${i ? "L" : "M"}${xy(p).map((v) => v.toFixed(1)).join(",")}`).join("") + "Z";
  return { xy, height, scale, widthM, ring };
}
