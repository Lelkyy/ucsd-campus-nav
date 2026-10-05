import { distanceMeters } from "./geo.ts";
import type { CampusGraph } from "./graph.ts";
import { findRoute, findRouteArriveBy, type Profile, type Route } from "./route.ts";
import type { TransitNetwork } from "./transit.ts";
import { entranceTargets } from "./indoor.ts";
import { EdgeKind, type Building, type LngLat, type Place } from "./types.ts";

export type Endpoint =
  /** roomAt: where the room is, when it's mapped indoors (routes go to the nearest door). */
  | { kind: "building"; building: Building; room?: string; roomAt?: LngLat }
  | { kind: "place"; place: Place }
  | { kind: "point"; lngLat: LngLat; label: string };

export function endpointPosition(e: Endpoint): LngLat {
  if (e.kind === "building") return e.building.center;
  if (e.kind === "place") return e.place.points[0];
  return e.lngLat;
}

export function endpointLabel(e: Endpoint): string {
  if (e.kind === "point") return e.label;
  if (e.kind === "place") return e.place.name;
  return e.room ? `${e.building.name} ${e.room}` : e.building.name;
}

export interface PlanOptions {
  profile: Profile;
  /** Shuttle network to allow, or null to walk only. */
  transit?: TransitNetwork | null;
  /** Leave at this time (default now)… */
  departAt?: Date;
  /** …or arrive by this time (wins over departAt). */
  arriveBy?: Date;
  /** See RouteOptions.walkWeight. */
  walkWeight?: number;
}

export type Plan =
  | {
      ok: true;
      route: Route;
      /** Straight "walk to the path" connectors from off-network points, if any. */
      connectors: [LngLat, LngLat][];
    }
  | { ok: false; error: string };

export type ResolvedTrip =
  | { ok: true; start: number[]; targets: number[]; connectors: [LngLat, LngLat][] }
  | { ok: false; error: string };

/** Graph nodes a trip can start and end at for a given way of travelling. */
export function resolveTrip(graph: CampusGraph, from: Endpoint, to: Endpoint, profile: Profile): ResolvedTrip {
  const connectors: [LngLat, LngLat][] = [];
  const accept = profile.travel === "bike" ? graph.onBikeNetwork : graph.onWalkNetwork;
  const stepFree = profile.speed[EdgeKind.Steps] === 0;
  const targets = endpointNodes(graph, to, connectors, false, accept, stepFree);
  if (targets.length === 0) return { ok: false, error: "Destination is too far from any mapped path." };
  // From a building, the router may leave through any of its exits and picks the best.
  const start = endpointNodes(graph, from, connectors, true, accept, stepFree);
  if (start.length === 0) return { ok: false, error: "Start is too far from any mapped path." };
  return { ok: true, start, targets, connectors };
}

/** Route between two endpoints, snapping free points onto the path network. */
export function planRoute(graph: CampusGraph, from: Endpoint, to: Endpoint, opts: PlanOptions): Plan {
  const trip = resolveTrip(graph, from, to, opts.profile);
  if (!trip.ok) return trip;
  const { start, targets, connectors } = trip;

  const route = opts.arriveBy
    ? findRouteArriveBy(graph, start, targets, opts.arriveBy, opts)
    : findRoute(graph, start, targets, opts);
  if (!route) {
    const needsShuttle = !opts.transit && to.kind === "building" && to.building.access === "shuttle";
    return {
      ok: false,
      error: needsShuttle
        ? "This building can only be reached by transit. Choose “Transit”."
        : opts.transit
          ? "No walking or transit route found at this time."
          : `No route found with "${opts.profile.label}".`,
    };
  }
  return { ok: true, route, connectors };
}

function endpointNodes(
  graph: CampusGraph,
  e: Endpoint,
  connectors: [LngLat, LngLat][],
  isStart: boolean,
  accept: (i: number) => boolean,
  stepFree: boolean,
): number[] {
  if (e.kind === "building") {
    return entranceTargets(e.building, (n) => graph.coord(n), { stepFree, roomAt: isStart ? undefined : e.roomAt });
  }
  if (e.kind === "place") {
    const nodes = e.place.points.map((p) => graph.nearestNode(p, { maxMeters: 300, accept })).filter((n) => n !== -1);
    return [...new Set(nodes)];
  }
  const node = graph.nearestNode(e.lngLat, { maxMeters: 300, accept });
  if (node === -1) return [];
  const snapped = graph.coord(node);
  if (distanceMeters(snapped, e.lngLat) > 1) {
    connectors.push(isStart ? [e.lngLat, snapped] : [snapped, e.lngLat]);
  }
  return [node];
}

/** When a transit trip is worth offering instead of walking. */
export const BUS_RULES = {
  /** Transit must beat walking by at least this much (avoids "1 min faster" noise from waiting). */
  minMinutesFaster: 1,
};

export type BusCheck = { ok: true } | { ok: false; reason: string };

/**
 * Use transit only if it's faster than walking: leaving now, it gets you there
 * sooner; arriving by a time, it lets you leave later. Otherwise walk.
 */
export function checkBusRoute(bus: Route | null, walk: Route | null, arriveBy?: Date): BusCheck {
  if (!bus) return { ok: false, reason: "No shuttle, bus or trolley helps on this trip right now." };
  // The fastest route with transit allowed doesn't use any: walking wins.
  if (!bus.usesTransit) return { ok: false, reason: "Walking is faster for this trip." };
  if (!walk) return { ok: true };
  const faster = arriveBy
    ? (bus.leaveAt.getTime() - walk.leaveAt.getTime()) / 60_000
    : (walk.arriveAt.getTime() - bus.arriveAt.getTime()) / 60_000;
  if (faster < BUS_RULES.minMinutesFaster) return { ok: false, reason: "Walking is faster for this trip." };
  return { ok: true };
}
