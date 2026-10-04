import type { LngLat } from "./types.ts";

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in meters. */
export function distanceMeters(a: LngLat, b: LngLat): number {
  return haversine(a[0], a[1], b[0], b[1]);
}

export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Average walking speed used for time estimates (~4.7 km/h). */
export const WALKING_SPEED_MPS = 1.3;

export function walkingMinutes(meters: number): number {
  return meters / WALKING_SPEED_MPS / 60;
}
