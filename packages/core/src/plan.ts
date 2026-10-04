import { distanceMeters } from "./geo.ts";
import type { CampusGraph } from "./graph.ts";
import { findRoute, findRouteArriveBy, type Profile, type Route } from "./route.ts";
import type { TransitNetwork } from "./transit.ts";
import type { Building, LngLat } from "./types.ts";

export type Endpoint =
  | { kind: "building"; building: Building; room?: string }
  | { kind: "point"; lngLat: LngLat; label: string };

export function endpointPosition(e: Endpoint): LngLat {
  return e.kind === "building" ? e.building.center : e.lngLat;
}

export function endpointLabel(e: Endpoint): string {
  if (e.kind === "point") return e.label;
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
  const targets = endpointNodes(graph, to, connectors, false, accept);
  if (targets.length === 0) return { ok: false, error: "Destination is too far from any mapped path." };

  // From a building, the router may leave through any of its exits and picks the best.
  const start = endpointNodes(graph, from, connectors, true, accept);
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
): number[] {
  if (e.kind === "building") return e.building.targets;
  const node = graph.nearestNode(e.lngLat, { maxMeters: 300, accept });
  if (node === -1) return [];
  const snapped = graph.coord(node);
  if (distanceMeters(snapped, e.lngLat) > 1) {
    connectors.push(isStart ? [e.lngLat, snapped] : [snapped, e.lngLat]);
  }
  return [node];
}
