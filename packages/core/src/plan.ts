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

/** Route between two endpoints, snapping free points onto the path network. */
export function planRoute(graph: CampusGraph, from: Endpoint, to: Endpoint, opts: PlanOptions): Plan {
  const connectors: [LngLat, LngLat][] = [];
  const accept = opts.profile.travel === "bike" ? graph.onBikeNetwork : graph.onWalkNetwork;
  const stepFree = opts.profile.speed[EdgeKind.Steps] === 0;
  const targets = endpointNodes(graph, to, connectors, false, accept, stepFree);
  if (targets.length === 0) return { ok: false, error: "Destination is too far from any mapped path." };

  // From a building, the router may leave through any of its exits and picks the best.
  const start = endpointNodes(graph, from, connectors, true, accept, stepFree);
  if (start.length === 0) return { ok: false, error: "Start is too far from any mapped path." };

  const route = opts.arriveBy
    ? findRouteArriveBy(graph, start, targets, opts.arriveBy, opts)
    : findRoute(graph, start, targets, opts);
  if (!route) {
    const needsShuttle = !opts.transit && to.kind === "building" && to.building.access === "shuttle";
    return {
      ok: false,
      error: needsShuttle
        ? "This building can only be reached by shuttle. Choose “Bus”."
        : opts.transit
          ? "No walking or shuttle route found at this time."
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

/** When a shuttle trip is worth offering instead of walking. */
export const BUS_RULES = {
  /** Must save at least this much walking… */
  minWalkSavedMeters: 250,
  /** …and at least this share of the walk. */
  minWalkSavedShare: 0.3,
  /** And can't take more than this much longer than walking. */
  maxExtraMinutes: 20,
};

export type BusCheck = { ok: true } | { ok: false; reason: string };

/**
 * Is `bus` (a route planned with shuttles allowed) a realistic alternative to
 * `walk` (the walking-only route for the same trip and time)?
 */
export function checkBusRoute(bus: Route | null, walk: Route | null, arriveBy?: Date): BusCheck {
  if (!bus || !bus.usesTransit) return { ok: false, reason: "No shuttle helps on this trip at this time." };
  if (!walk) return { ok: true };
  const saved = walk.meters - bus.meters;
  if (saved < BUS_RULES.minWalkSavedMeters || saved < walk.meters * BUS_RULES.minWalkSavedShare) {
    return { ok: false, reason: "The shuttle would barely save any walking on this trip." };
  }
  // Arriving by a time: how much earlier you'd have to leave. Leaving now: how much later you'd get there.
  const extra = arriveBy
    ? (walk.leaveAt.getTime() - bus.leaveAt.getTime()) / 60_000
    : (bus.arriveAt.getTime() - walk.arriveAt.getTime()) / 60_000;
  if (extra > BUS_RULES.maxExtraMinutes) {
    return { ok: false, reason: `The shuttle would take ${Math.round(extra)} min longer than walking.` };
  }
  return { ok: true };
}
