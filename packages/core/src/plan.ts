import { distanceMeters } from "./geo.ts";
import type { CampusGraph } from "./graph.ts";
import { edgeTravel, findRoute, findRouteArriveBy, type Profile, type Route } from "./route.ts";
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

/** Where a free point meets the network: the closest point on an edge (routes start or end there). */
export interface Approach {
  at: LngLat;
  edge: number;
}

export type ResolvedTrip =
  | {
      ok: true;
      start: number[];
      targets: number[];
      connectors: [LngLat, LngLat][];
      /** For free points: where they meet the network, so the route can run to that exact spot. */
      ends: { start?: Approach; end?: Approach };
    }
  | { ok: false; error: string };

/** Graph nodes a trip can start and end at for a given way of travelling. */
export function resolveTrip(graph: CampusGraph, from: Endpoint, to: Endpoint, profile: Profile): ResolvedTrip {
  const connectors: [LngLat, LngLat][] = [];
  const ends: { start?: Approach; end?: Approach } = {};
  const accept = profile.travel === "bike" ? graph.onBikeNetwork : graph.onWalkNetwork;
  // A free point joins a real path, not a cut across the grass.
  const usable = (e: number) => profile.speed[graph.kind(e)] > 0 && graph.kind(e) !== EdgeKind.Gap;
  const stepFree = profile.speed[EdgeKind.Steps] === 0;
  const riding = profile.travel === "bike";
  const targets = endpointNodes(graph, to, connectors, false, accept, usable, stepFree, riding, (a) => (ends.end = a));
  if (targets.length === 0) return { ok: false, error: "Destination is too far from any mapped path." };
  // From a building, the router may leave through any of its exits and picks the best.
  const start = endpointNodes(graph, from, connectors, true, accept, usable, stepFree, riding, (a) => (ends.start = a));
  if (start.length === 0) return { ok: false, error: "Start is too far from any mapped path." };
  return { ok: true, start, targets, connectors, ends };
}

/** Route between two endpoints, snapping free points onto the path network. */
export function planRoute(graph: CampusGraph, from: Endpoint, to: Endpoint, opts: PlanOptions): Plan {
  const trip = resolveTrip(graph, from, to, opts.profile);
  if (!trip.ok) return trip;
  const { start, targets, connectors } = trip;

  const costs = approachCosts(graph, trip.ends, opts.profile);
  const found = opts.arriveBy
    ? findRouteArriveBy(graph, start, targets, opts.arriveBy, { ...opts, ...costs })
    : findRoute(graph, start, targets, { ...opts, ...costs });
  const route = found && attachEnds(graph, found, trip.ends, opts.profile);
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
  usable: (e: number) => boolean,
  stepFree: boolean,
  riding: boolean,
  onApproach: (a: Approach) => void,
): number[] {
  if (e.kind === "building") {
    const doors = entranceTargets(e.building, (n) => graph.coord(n), { stepFree, roomAt: isStart ? undefined : e.roomAt });
    // A bike can also pull up on a road beside the building that has no sidewalk to walk.
    return riding ? [...doors, ...(e.building.rideTargets ?? [])] : doors;
  }
  if (e.kind === "place") {
    const nodes = e.place.points.map((p) => graph.nearestNode(p, { maxMeters: 300, accept })).filter((n) => n !== -1);
    return [...new Set(nodes)];
  }
  // A free point joins the nearest path or road at its closest point (a short, straight dotted
  // line), and the route runs along that edge from there, whichever way is better.
  const hit = graph.nearestEdgePoint(e.lngLat, { maxMeters: 300, accept, usable });
  if (!hit) return [];
  if (hit.meters > 1) connectors.push(isStart ? [e.lngLat, hit.at] : [hit.at, e.lngLat]);
  onApproach({ at: hit.at, edge: hit.edge });
  return [graph.edgeFrom[hit.edge], graph.edgeTo[hit.edge]];
}

/** For the router: how long from where each free end meets its path to either end of that path. */
export function approachCosts(
  graph: CampusGraph,
  ends: { start?: Approach; end?: Approach },
  profile: Profile,
): { startCost?: Map<number, number>; targetCost?: Map<number, number> } {
  const costs = (a?: Approach) => {
    if (!a) return undefined;
    const map = new Map<number, number>();
    for (const node of [graph.edgeFrom[a.edge], graph.edgeTo[a.edge]]) {
      // Heading for `node` from the start point, or coming from `node` to the end point.
      const { speed, prefer } = approachTravel(graph, profile, a.edge, a === ends.start ? node : graph.other(a.edge, node));
      map.set(node, (distanceMeters(a.at, graph.coord(node)) / speed) * prefer);
    }
    return map;
  };
  return { startCost: costs(ends.start), targetCost: costs(ends.end) };
}

/** Travel along part of an edge towards node `toward`; walking (or walking the bike) where the profile can't. */
function approachTravel(graph: CampusGraph, profile: Profile, edge: number, toward: number): { speed: number; prefer: number } {
  const t = edgeTravel(graph, profile, edge, graph.other(edge, toward));
  return t.speed ? t : { speed: profile.speed[EdgeKind.Path], prefer: 1 };
}

/**
 * Extend a route found between nodes to where its free ends actually meet the
 * network: from the closest point on the start's edge to the node the route
 * leaves from, and from its last node to the end's closest point.
 */
export function attachEnds(graph: CampusGraph, route: Route, ends: { start?: Approach; end?: Approach }, profile: Profile): Route {
  const legs = route.legs.slice();
  let coordinates = route.coordinates;
  let meters = route.meters;
  let startSec = 0;
  let endSec = 0;
  const extend = (approach: Approach | undefined, legIndex: number, atStart: boolean) => {
    const leg = legs[legIndex];
    if (!approach || !leg || leg.mode === "bus" || !leg.nodes.length) return;
    const node = atStart ? leg.nodes[0] : leg.nodes[leg.nodes.length - 1];
    if (node !== graph.edgeFrom[approach.edge] && node !== graph.edgeTo[approach.edge]) return;
    const d = distanceMeters(approach.at, graph.coord(node));
    if (d < 0.5) return;
    const { speed } = approachTravel(graph, profile, approach.edge, atStart ? node : graph.other(approach.edge, node));
    const sec = d / speed;
    legs[legIndex] = atStart
      ? { ...leg, coordinates: [approach.at, ...leg.coordinates], nodes: [-1, ...leg.nodes], edges: [-1, ...leg.edges], meters: leg.meters + d, seconds: leg.seconds + sec }
      : { ...leg, coordinates: [...leg.coordinates, approach.at], nodes: [...leg.nodes, -1], edges: [...leg.edges, -1], meters: leg.meters + d, seconds: leg.seconds + sec };
    coordinates = atStart ? [approach.at, ...coordinates] : [...coordinates, approach.at];
    meters += d;
    if (atStart) startSec = sec;
    else endSec = sec;
  };
  extend(ends.start, 0, true);
  extend(ends.end, legs.length - 1, false);
  if (!startSec && !endSec) return route;
  return {
    ...route,
    legs,
    coordinates,
    meters,
    minutes: route.minutes + (startSec + endSec) / 60,
    seconds: route.seconds + startSec + endSec,
    leaveAt: new Date(route.leaveAt.getTime() - startSec * 1000),
    arriveAt: new Date(route.arriveAt.getTime() + endSec * 1000),
  };
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
