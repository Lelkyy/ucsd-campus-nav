import { haversine } from "./geo.ts";
import type { LngLat } from "./types.ts";

/**
 * Live trolleys and buses where they last reported: MTS's GTFS-realtime vehicle positions (one
 * small protobuf for the whole fleet), each vehicle at its GPS fix as reported, with when the fix
 * was taken. Nothing is estimated: a vehicle stays at its fix until the next one comes.
 */
export interface LiveVehicle {
  id: string;
  /** The trip it's running (OneBusAway id, "MTS_<trip>"), for its route ahead (`tripAhead`). */
  tripId?: string;
  mode: "trolley" | "bus";
  /** The route's number ("201", "510"). */
  route: string;
  /** Its GPS fix. */
  lngLat: LngLat;
  /** When the fix was taken (ms since the epoch). */
  fixAt: number;
  /** Compass heading (0 = north), from its last two fixes, once it has moved between them. */
  heading?: number;
  /** What riders call it: "Blue Line" for a trolley (MTS names them by color), the route number for a bus. */
  line: string;
  /** Line color, "#rrggbb". */
  color: string;
}

/** One vehicle's report in a GTFS-realtime VehiclePosition feed. */
export interface VehicleFix {
  vehicleId: string;
  tripId?: string;
  routeId?: string;
  lngLat: LngLat;
  /** When the fix was taken (ms since the epoch). */
  at: number;
  /** Compass bearing, when the feed gives one (MTS's doesn't). */
  bearing?: number;
}

type ProtoValue = number | [number, number];

/**
 * Just enough of the protobuf wire format to read GTFS-realtime, so no protobuf library: `fields`
 * calls back with each field in [start, end): its number, and a number, or a [start, end) for bytes.
 */
function protoReader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = (start: number, end: number, cb: (field: number, value: ProtoValue) => void) => {
    let i = start;
    const varint = () => {
      const first = i;
      let [n, scale] = [0, 1];
      let b: number;
      do {
        b = bytes[i++];
        n += (b & 0x7f) * scale;
        scale *= 128;
      } while (b & 0x80);
      // A negative int32 (a delay) is ten bytes; its low 32 bits, from the first five, are the value.
      if (i - first > 5) {
        let lo = 0;
        for (let k = 0, sc = 1; k < 5; k++, sc *= 128) lo += (bytes[first + k] & 0x7f) * sc;
        return lo % 2 ** 32 | 0;
      }
      return n;
    };
    while (i < end) {
      const key = varint();
      const [field, wire] = [Math.floor(key / 8), key & 7];
      if (wire === 0) cb(field, varint());
      else if (wire === 2) {
        const len = varint();
        cb(field, [i, i + len]);
        i += len;
      } else if (wire === 5) {
        cb(field, view.getFloat32(i, true));
        i += 4;
      } else if (wire === 1) {
        cb(field, view.getFloat64(i, true));
        i += 8;
      } else throw new Error(`GTFS-realtime: unsupported wire type ${wire}`);
    }
  };
  // Ids are plain ASCII.
  const str = (r: ProtoValue) => (typeof r === "number" ? "" : String.fromCharCode(...bytes.subarray(r[0], r[1])));
  const sub = (r: ProtoValue, cb: (field: number, value: ProtoValue) => void) => typeof r !== "number" && fields(r[0], r[1], cb);
  /** The feed's header time and each entity, in order. */
  const entities = (cb: (entity: ProtoValue) => void) => {
    let at = 0;
    fields(0, bytes.length, (f, v) => {
      if (f === 1) sub(v, (g, x) => g === 3 && typeof x === "number" && (at = x * 1000));
      if (f === 2) cb(v);
    });
    return at;
  };
  return { sub, str, entities };
}

/** The vehicle reports in a GTFS-realtime FeedMessage: for each VehiclePosition, its vehicle, trip, route, position and timestamp. */
export function decodeVehiclePositions(bytes: Uint8Array): { at: number; fixes: VehicleFix[] } {
  const { sub, str, entities } = protoReader(bytes);
  const fixes: VehicleFix[] = [];
  const at = entities((v) =>
    sub(v, (g, x) => {
      if (g !== 4) return;
      const fix: Partial<VehicleFix> & { lat?: number; lon?: number; label?: string } = {};
      sub(x, (h, y) => {
        if (h === 1) sub(y, (k, z) => (k === 1 ? (fix.tripId = str(z)) : k === 5 ? (fix.routeId = str(z)) : undefined));
        else if (h === 2) sub(y, (k, z) => (k === 1 ? (fix.lat = z as number) : k === 2 ? (fix.lon = z as number) : k === 3 ? (fix.bearing = z as number) : undefined));
        else if (h === 5 && typeof y === "number") fix.at = y * 1000;
        else if (h === 8) sub(y, (k, z) => (k === 1 ? (fix.vehicleId = str(z)) : k === 2 ? (fix.label = str(z)) : undefined));
      });
      const id = fix.vehicleId || fix.label;
      if (id && fix.lat !== undefined && fix.lon !== undefined && fix.at) {
        fixes.push({
          vehicleId: id,
          ...(fix.tripId ? { tripId: fix.tripId } : {}),
          ...(fix.routeId ? { routeId: fix.routeId } : {}),
          lngLat: [fix.lon, fix.lat],
          at: fix.at,
          ...(fix.bearing !== undefined ? { bearing: fix.bearing } : {}),
        });
      }
    }),
  );
  return { at, fixes };
}

/** One trip's predicted times at the stops it hasn't reached yet, from a GTFS-realtime TripUpdate. */
export interface TripUpdate {
  tripId: string;
  routeId?: string;
  vehicleId?: string;
  /** When the prediction was made (ms since the epoch). */
  at: number;
  /** How late the trip is running, in seconds, when the feed says (MTS rarely does). */
  delay?: number;
  stops: StopTimePrediction[];
}

export interface StopTimePrediction {
  stopId: string;
  stopSequence?: number;
  /** Predicted arrival and departure (ms since the epoch). MTS rounds most to the minute. */
  arrival?: number;
  departure?: number;
}

/** The predictions in a GTFS-realtime TripUpdates feed (MTS's trip-updates-for-agency). */
export function decodeTripUpdates(bytes: Uint8Array): { at: number; trips: TripUpdate[] } {
  const { sub, str, entities } = protoReader(bytes);
  const trips: TripUpdate[] = [];
  const time = (r: ProtoValue) => {
    let t: number | undefined;
    sub(r, (k, z) => k === 2 && typeof z === "number" && (t = z * 1000));
    return t;
  };
  const at = entities((v) =>
    sub(v, (g, x) => {
      if (g !== 3) return;
      const trip: Partial<TripUpdate> & { stops: StopTimePrediction[] } = { stops: [] };
      sub(x, (h, y) => {
        if (h === 1) sub(y, (k, z) => (k === 1 ? (trip.tripId = str(z)) : k === 5 ? (trip.routeId = str(z)) : undefined));
        else if (h === 3) sub(y, (k, z) => k === 1 && (trip.vehicleId = str(z)));
        else if (h === 4 && typeof y === "number") trip.at = y * 1000;
        else if (h === 5 && typeof y === "number") trip.delay = y;
        else if (h === 2) {
          const stop: Partial<StopTimePrediction> = {};
          sub(y, (k, z) => {
            if (k === 1 && typeof z === "number") stop.stopSequence = z;
            else if (k === 4) stop.stopId = str(z);
            else if (k === 2) stop.arrival = time(z);
            else if (k === 3) stop.departure = time(z);
          });
          if (stop.stopId) trip.stops.push(stop as StopTimePrediction);
        }
      });
      if (trip.tripId) trips.push({ ...trip, tripId: trip.tripId, at: trip.at ?? 0 });
    }),
  );
  return { at, trips };
}

/** A route from OneBusAway's routes-for-agency list. */
export interface LiveRoute {
  id: string;
  shortName?: string;
  longName?: string;
  /** GTFS route type: 0 tram (MTS's trolleys), 3 bus. */
  type?: number;
  color?: string;
}

/** GTFS route types: tram, streetcar and light rail (MTS's trolley lines); bus. */
const MODES: Record<number, LiveVehicle["mode"]> = { 0: "trolley", 3: "bus" };
/** A fix older than this is a vehicle out of service (they linger in the feed for hours). */
export const STALE_FIX_MS = 5 * 60_000;

/**
 * Trolleys and buses from their fixes, named from the agency's routes (OneBusAway ids, the feed's
 * ids with the agency in front: "MTS_510"). Vehicles not on a trolley or bus route, or with a
 * stale fix, are left out. A vehicle's heading comes from its previous fix, when it has moved.
 */
export function liveVehicles(
  fixes: VehicleFix[],
  routes: Map<string, LiveRoute>,
  opts: { agency?: string; now?: number; before?: Map<string, LiveVehicle> } = {},
): LiveVehicle[] {
  const agency = opts.agency ?? "MTS";
  const now = opts.now ?? Date.now();
  return fixes.flatMap((f): LiveVehicle[] => {
    const route = f.routeId ? routes.get(`${agency}_${f.routeId}`) : undefined;
    const mode = route?.type !== undefined ? MODES[route.type] : undefined;
    if (!route || !mode || now - f.at > STALE_FIX_MS) return [];
    const prev = opts.before?.get(f.vehicleId);
    const moved = prev && prev.fixAt !== f.at ? haversine(prev.lngLat[0], prev.lngLat[1], f.lngLat[0], f.lngLat[1]) : 0;
    const heading = f.bearing ?? (prev && moved >= MOVED_METERS ? compassBearing(prev.lngLat, f.lngLat) : prev?.heading);
    return [
      {
        id: f.vehicleId,
        ...(f.tripId ? { tripId: `${agency}_${f.tripId}` } : {}),
        mode,
        route: route.shortName || route.id,
        lngLat: f.lngLat,
        fixAt: f.at,
        ...(heading !== undefined ? { heading } : {}),
        line: mode === "trolley" && route.shortName ? `${route.shortName} Line` : route.shortName || route.longName || route.id,
        color: route.color ? `#${route.color.replace(/^#/, "")}` : "#4A6497",
      },
    ];
  });
}

/** Moving less than this between fixes (GPS wander) doesn't change a vehicle's heading. */
const MOVED_METERS = 12;

function compassBearing(a: LngLat, b: LngLat): number {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return ((Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

/** Points of a Google encoded polyline (as OneBusAway's `where/shape` gives a trip's path). */
export function decodePolyline(encoded: string): LngLat[] {
  const points: LngLat[] = [];
  let [i, lat, lon] = [0, 0, 0];
  const next = () => {
    let [shift, result, b] = [0, 0, 0];
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lon += next();
    points.push([lon / 1e5, lat / 1e5]);
  }
  return points;
}

/** A vehicle's trip: the path already covered, the path still ahead, and each stop. */
export interface TripAhead {
  /** Where it's going ("UTC"). */
  headsign?: string;
  /** From the vehicle's fix to the end of the trip. */
  path: LngLat[];
  /** From the start of the trip up to the vehicle's fix (the trail it has already run). */
  behind: LngLat[];
  /** Compass heading of the path at the vehicle (0 = north). */
  heading?: number;
  /** Stops still to come, with MTS's times. */
  stops: {
    id: string;
    name: string;
    lngLat: LngLat;
    /** Predicted arrival, ms since the epoch. */
    at: number;
    /** Meters along the trip's path. */
    along: number;
  }[];
  /** Stops the vehicle has already passed. */
  passed: { id: string; name: string; lngLat: LngLat; along: number }[];
}

interface ObaTripDetails {
  data?: {
    entry?: {
      tripId?: string;
      serviceDate?: number;
      schedule?: { stopTimes?: { stopId: string; arrivalTime: number; distanceAlongTrip: number }[] };
      status?: { distanceAlongTrip?: number; scheduleDeviation?: number; serviceDate?: number };
    };
    references?: { stops?: { id: string; name: string; lat: number; lon: number }[]; trips?: { id: string; tripHeadsign?: string }[] };
  };
}

/**
 * Where a vehicle still has to go, from a trip-details response (with schedule and status) and
 * the trip's path: the path on from its GPS fix `at` (the nearest point of the path, looking no
 * more than 2 km behind where MTS reckons it is, for routes that loop back), and the stops after
 * that, each at its timetabled arrival plus the vehicle's current delay (MTS's figures).
 */
export function tripAhead(details: ObaTripDetails, path: LngLat[], at?: LngLat): TripAhead {
  const entry = details.data?.entry;
  const status = entry?.status;
  const day = status?.serviceDate ?? entry?.serviceDate ?? 0;
  const delay = status?.scheduleDeviation ?? 0;
  const headsign = details.data?.references?.trips?.find((t) => t.id === entry?.tripId)?.tripHeadsign;
  const measured = measurePath(path);
  const reckoned = status?.distanceAlongTrip ?? 0;
  const along = at && path.length > 1 ? alongPath(measured, at, Math.max(0, reckoned - 2000)) : reckoned;
  const stopRefs = new Map((details.data?.references?.stops ?? []).map((s) => [s.id, s]));
  const times = entry?.schedule?.stopTimes ?? [];
  const pin = (t: { stopId: string; distanceAlongTrip: number }) => {
    const s = stopRefs.get(t.stopId);
    return s ? { id: s.id, name: s.name, lngLat: [s.lon, s.lat] as LngLat, along: t.distanceAlongTrip } : null;
  };
  const stops = times
    .filter((t) => t.distanceAlongTrip > along)
    .flatMap((t) => {
      const s = pin(t);
      return s ? [{ ...s, at: day + (t.arrivalTime + delay) * 1000 }] : [];
    });
  const passed = times.filter((t) => t.distanceAlongTrip <= along).flatMap((t) => pin(t) ?? []);
  const ahead = path.length > 1 ? pathFrom(measured, along) : [];
  const behind = path.length > 1 ? pathUntil(measured, along) : [];
  // Starting / ending right at the vehicle.
  if (at && ahead.length) ahead[0] = at;
  if (at && behind.length) behind[behind.length - 1] = at;
  const heading = path.length > 1 ? pointAlong(measured, along).heading : undefined;
  return { ...(headsign ? { headsign } : {}), path: ahead, behind, ...(heading !== undefined ? { heading } : {}), stops, passed };
}

/** A path with the distance from its start to each point, for finding a point a distance along it. */
export interface MeasuredPath {
  points: LngLat[];
  /** Meters from the start to each point. */
  at: number[];
  length: number;
}

export function measurePath(points: LngLat[]): MeasuredPath {
  const at = [0];
  for (let k = 1; k < points.length; k++) {
    at.push(at[k - 1] + haversine(points[k - 1][0], points[k - 1][1], points[k][0], points[k][1]));
  }
  return { points, at, length: at[at.length - 1] ?? 0 };
}

/** The point `meters` along a path (clamped to its ends), and the compass heading of the path there. */
export function pointAlong(path: MeasuredPath, meters: number): { lngLat: LngLat; heading: number } {
  const { points, at } = path;
  const d = Math.max(0, Math.min(path.length, meters));
  // Binary search for the segment holding d.
  let [lo, hi] = [0, points.length - 1];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid] <= d) lo = mid;
    else hi = mid;
  }
  const [a, b] = [points[lo], points[hi] ?? points[lo]];
  const seg = at[hi] - at[lo];
  const t = seg > 0 ? (d - at[lo]) / seg : 0;
  const kx = Math.cos((a[1] * Math.PI) / 180);
  const heading = ((Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
  return { lngLat: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading };
}

/** The rest of a path from `meters` along it: that point, then every point after. */
export function pathFrom(path: MeasuredPath, meters: number): LngLat[] {
  if (path.points.length < 2) return path.points;
  const start = pointAlong(path, meters).lngLat;
  const next = path.at.findIndex((d) => d > meters);
  return next === -1 ? [start] : [start, ...path.points.slice(next)];
}

/** The stretch of a path from the start up to `meters` along it (the trail already covered). */
export function pathUntil(path: MeasuredPath, meters: number): LngLat[] {
  if (path.points.length < 2) return path.points;
  const end = pointAlong(path, meters).lngLat;
  const last = path.at.findIndex((d) => d >= meters);
  if (last === -1) return path.points;
  const keep = path.points.slice(0, last);
  return keep.length ? [...keep, end] : [end];
}

/**
 * How far along a path a point lies: the nearest place on the path to it, looking only from
 * `from` meters on (so a route that comes back past the same spot isn't confused).
 */
export function alongPath(path: MeasuredPath, p: LngLat, from = 0): number {
  const { points, at } = path;
  const kx = Math.cos((p[1] * Math.PI) / 180);
  let [best, bestD] = [from, Infinity];
  for (let k = 1; k < points.length; k++) {
    if (at[k] < from) continue;
    const [a, b] = [points[k - 1], points[k]];
    const [ax, ay] = [(a[0] - p[0]) * kx, a[1] - p[1]];
    const [dx, dy] = [(b[0] - a[0]) * kx, b[1] - a[1]];
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    const along = at[k - 1] + t * (at[k] - at[k - 1]);
    if (d < bestD && along >= from) [best, bestD] = [along, d];
  }
  return best;
}
