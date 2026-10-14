import type { LngLat } from "./types.ts";

/**
 * Live transit vehicles from a OneBusAway API (`where/vehicles-for-agency/{agency}.json`), as MTS
 * publishes for San Diego: where each trolley and bus is, which way it's heading and its next stop.
 */
export interface LiveVehicle {
  id: string;
  mode: "trolley" | "bus";
  /** The route's number ("201", "510"). */
  route: string;
  lngLat: LngLat;
  /** Compass heading in degrees (0 = north, 90 = east), when the feed says. */
  heading?: number;
  /** "Blue Line" (or the route's short name). */
  line: string;
  /** Line color, "#rrggbb". */
  color: string;
  /** Where it's going ("UTC"). */
  headsign?: string;
  nextStop?: { name: string; /** Seconds from the feed's time until it gets there. */ inSeconds: number };
  /** Whether the times are live predictions rather than the timetable. */
  predicted: boolean;
}

interface ObaVehicle {
  vehicleId: string;
  tripId?: string;
  location?: { lat: number; lon: number };
  tripStatus?: {
    activeTripId?: string;
    position?: { lat: number; lon: number };
    /** OneBusAway: degrees counterclockwise from east (0 = east, 90 = north). */
    orientation?: number;
    nextStop?: string;
    nextStopTimeOffset?: number;
    predicted?: boolean;
  };
}
interface ObaResponse {
  data?: {
    list?: ObaVehicle[];
    references?: {
      trips?: { id: string; routeId: string; tripHeadsign?: string }[];
      routes?: { id: string; shortName?: string; longName?: string; type?: number; color?: string }[];
      stops?: { id: string; name: string }[];
    };
  };
}

/** GTFS route types: tram, streetcar and light rail (MTS's trolley lines); bus. */
const MODES: Record<number, LiveVehicle["mode"]> = { 0: "trolley", 3: "bus" };

/** The trolleys and buses running a trip, from a vehicles-for-agency response. */
export function liveVehicles(response: ObaResponse): LiveVehicle[] {
  const refs = response.data?.references ?? {};
  const trips = new Map((refs.trips ?? []).map((t) => [t.id, t]));
  const routes = new Map((refs.routes ?? []).map((r) => [r.id, r]));
  const stops = new Map((refs.stops ?? []).map((s) => [s.id, s]));
  const out: LiveVehicle[] = [];
  for (const v of response.data?.list ?? []) {
    const trip = trips.get(v.tripStatus?.activeTripId ?? v.tripId ?? "");
    const route = trip && routes.get(trip.routeId);
    const mode = route?.type !== undefined ? MODES[route.type] : undefined;
    if (!trip || !route || !mode) continue;
    const at = v.tripStatus?.position ?? v.location;
    if (!at) continue;
    const s = v.tripStatus;
    const next = s?.nextStop ? stops.get(s.nextStop) : undefined;
    out.push({
      id: v.vehicleId,
      mode,
      route: route.shortName || route.id,
      lngLat: [at.lon, at.lat],
      heading: s?.orientation !== undefined ? (((90 - s.orientation) % 360) + 360) % 360 : undefined,
      line: route.longName || route.shortName || route.id,
      color: route.color ? `#${route.color.replace(/^#/, "")}` : "#4A6497",
      headsign: trip.tripHeadsign,
      nextStop: next && s?.nextStopTimeOffset !== undefined ? { name: next.name, inSeconds: s.nextStopTimeOffset } : undefined,
      predicted: !!s?.predicted,
    });
  }
  return out;
}
