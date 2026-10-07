import { MinHeap } from "./heap.ts";
import { WALKING_SPEED_MPS, haversine } from "./geo.ts";
import type { CampusGraph } from "./graph.ts";
import { secondsSinceMidnight, type TransitNetwork, type TransitRoute, type TransitStop } from "./transit.ts";
import { BikeDir, EdgeKind, type LngLat } from "./types.ts";

/** How you get around: travel speed and route preference per kind of path. */
export interface Profile {
  id: string;
  label: string;
  /** What the person is doing on the network (shown in directions). */
  travel: "walk" | "bike";
  /** Speed in m/s on each edge kind; 0 means that kind can't be used. */
  speed: Record<EdgeKind, number>;
  /**
   * Preference multiplier on travel time (>= 1, default 1): makes a kind feel
   * slower than it is, so routes favour others when they're about equal.
   */
  prefer?: Partial<Record<EdgeKind, number>>;
  /**
   * Riding only: speed going the wrong way along a one-way (0 or missing = not allowed). Riding
   * against traffic isn't: off the bike and walk it, where there's a sidewalk or path to walk on.
   */
  againstOneway?: Partial<Record<EdgeKind, number>>;
  /** Riding only: preference on a road with a bike lane in your direction (instead of the road's). */
  inBikeLane?: number;
}

/**
 * Speed and preference for travelling edge `e` from node `from`. Riders keep right: one-ways
 * only with the traffic, and a road's bike lane only in the direction it serves.
 */
export function edgeTravel(graph: CampusGraph, profile: Profile, e: number, from: number): { speed: number; prefer: number } {
  const kind = graph.kind(e);
  const prefer = profile.prefer?.[kind] ?? 1;
  if (profile.travel !== "bike") return { speed: profile.speed[kind], prefer };
  const dir = graph.edgeBikeDir[e];
  const forward = graph.edgeFrom[e] === from;
  if (dir & (forward ? BikeDir.NoForward : BikeDir.NoBackward)) return { speed: profile.againstOneway?.[kind] ?? 0, prefer: 1 };
  if (dir & (forward ? BikeDir.LaneForward : BikeDir.LaneBackward)) return { speed: profile.speed[kind], prefer: profile.inBikeLane ?? prefer };
  return { speed: profile.speed[kind], prefer };
}

/** Road kinds a rider shares with traffic (drawn on the right-hand side of the road). */
const ROAD_KINDS = new Set<EdgeKind>([EdgeKind.Road, EdgeKind.Sidewalk, EdgeKind.BikeOnly]);

/**
 * A ride split into stretches on roads (ridden, so on the right-hand side) and everything else
 * (paths, and roads where the bike is walked), for drawing.
 */
export function rideRuns(graph: CampusGraph, profile: Profile, leg: MoveLeg): { coordinates: LngLat[]; keepRight: boolean }[] {
  const runs: { coordinates: LngLat[]; keepRight: boolean }[] = [];
  for (let k = 0; k + 1 < leg.coordinates.length; k++) {
    const e = leg.edges[k];
    const keepRight =
      e >= 0 && ROAD_KINDS.has(graph.kind(e)) && edgeTravel(graph, profile, e, leg.nodes[k]).speed >= PUSH_THRESHOLD;
    const run = runs[runs.length - 1];
    if (run && run.keepRight === keepRight) run.coordinates.push(leg.coordinates[k + 1]);
    else runs.push({ coordinates: [leg.coordinates[k], leg.coordinates[k + 1]], keepRight });
  }
  return runs;
}

const WALK = WALKING_SPEED_MPS;
/** Typical relaxed campus cycling speed (~18 km/h). */
const RIDE = 5;
/** Riding slowly among pedestrians on shared paths. */
const RIDE_SHARED = 3.5;
/** Walking a bike where riding isn't allowed. */
const PUSH = 1.2;

const WALK_PREFER = { [EdgeKind.Sidewalk]: 1.05, [EdgeKind.Lot]: 1.1, [EdgeKind.Bike]: 1.5, [EdgeKind.Road]: 10, [EdgeKind.Gap]: 1.25 };

/**
 * Cutting across open ground between paths (EdgeKind.Gap) has to be worth it for the trip as a
 * whole: it must save this share of the trip's time, and at least this many seconds.
 */
export const GAP_MIN_SAVING = { share: 0.1, seconds: 20 };

export const PROFILES = {
  walk: {
    id: "walk",
    label: "Walk",
    travel: "walk",
    speed: {
      [EdgeKind.Path]: WALK,
      [EdgeKind.Custom]: WALK,
      [EdgeKind.Shared]: WALK,
      [EdgeKind.Bike]: WALK,
      [EdgeKind.Road]: WALK,
      [EdgeKind.Sidewalk]: WALK,
      // Climbing stairs is slower than walking the same distance on the flat.
      [EdgeKind.Steps]: WALK / 1.4,
      [EdgeKind.BikeOnly]: 0,
      [EdgeKind.Gap]: WALK,
      [EdgeKind.Lot]: WALK,
    },
    // Prefer footpaths, then sidewalks along roads. Bike paths only for a real time saving
    // (a third or more on that stretch); a road with no sidewalk only when nothing else goes there.
    prefer: WALK_PREFER,
  },
  accessible: {
    id: "accessible",
    label: "Avoid stairs",
    travel: "walk",
    speed: {
      [EdgeKind.Path]: WALK,
      [EdgeKind.Custom]: WALK,
      [EdgeKind.Shared]: WALK,
      [EdgeKind.Bike]: WALK,
      [EdgeKind.Road]: WALK,
      [EdgeKind.Sidewalk]: WALK,
      [EdgeKind.Steps]: 0,
      [EdgeKind.BikeOnly]: 0,
      // Lawns and fields aren't step-free ground; parking lots are.
      [EdgeKind.Gap]: 0,
      [EdgeKind.Lot]: WALK,
    },
    prefer: WALK_PREFER,
  },
  bike: {
    id: "bike",
    label: "Bike",
    travel: "bike",
    speed: {
      [EdgeKind.Bike]: RIDE,
      [EdgeKind.Road]: RIDE,
      [EdgeKind.Sidewalk]: RIDE,
      [EdgeKind.BikeOnly]: RIDE,
      [EdgeKind.Shared]: RIDE_SHARED,
      // Footpaths and hand-traced paths: get off and walk the bike.
      [EdgeKind.Path]: PUSH,
      [EdgeKind.Custom]: PUSH,
      // Carrying a bike up or down stairs: possible, but only as a last resort.
      [EdgeKind.Steps]: 0.4,
      // Cutting across the grass is for walkers; across a parking lot, walk the bike.
      [EdgeKind.Gap]: 0,
      [EdgeKind.Lot]: PUSH,
    },
    // Bike paths and bike lanes first, then quiet shared paths, then roads.
    prefer: { [EdgeKind.Road]: 1.15, [EdgeKind.Sidewalk]: 1.15, [EdgeKind.BikeOnly]: 1.2, [EdgeKind.Shared]: 1.05, [EdgeKind.Steps]: 3 },
    inBikeLane: 1,
    // The wrong way down a one-way: walk the bike on its sidewalk or path, never ride.
    againstOneway: {
      [EdgeKind.Sidewalk]: PUSH,
      [EdgeKind.Bike]: PUSH,
      [EdgeKind.Shared]: PUSH,
      [EdgeKind.Path]: PUSH,
      [EdgeKind.Custom]: PUSH,
      [EdgeKind.Steps]: 0.4,
    },
  },
} satisfies Record<string, Profile>;

export type ProfileId = keyof typeof PROFILES;

/** The commute options offered in the app. */
export const MODES = {
  walk: { label: "Walk", profile: PROFILES.walk, transit: false, walkWeight: 1 },
  accessible: { label: "No stairs", profile: PROFILES.accessible, transit: false, walkWeight: 1 },
  bike: { label: "Bike", profile: PROFILES.bike, transit: false, walkWeight: 1 },
  // Transit (shuttles, MTS buses, the trolley): the fastest trip, used only when it beats walking.
  bus: { label: "Transit", profile: PROFILES.walk, transit: true, walkWeight: 1 },
} as const;

export type ModeId = keyof typeof MODES;

/** Walking and riding speeds below this count as pushing the bike. */
const PUSH_THRESHOLD = 2;

export interface RouteOptions {
  profile?: Profile;
  /** Shuttle network to ride (walking profiles only), or null/undefined for none. */
  transit?: TransitNetwork | null;
  departAt?: Date;
  /**
   * How much a second of walking (or riding) costs compared with a second of
   * waiting or riding a shuttle. 1 = fastest trip; higher = less walking, even if
   * the trip takes longer (e.g. 10: one minute less walking is worth ten minutes).
   */
  walkWeight?: number;
  /** Perceived cost of each boarding in seconds (default 60). Higher = fewer transfers. */
  boardPenalty?: number;
  /**
   * Seconds of travel (preferences included) to reach each start node / to go on from
   * each target node: a free point that joins a path mid-way can go either way along it.
   */
  startCost?: ReadonlyMap<number, number>;
  targetCost?: ReadonlyMap<number, number>;
  /** Stay on the paths: no cutting across open ground (EdgeKind.Gap). */
  noGaps?: boolean;
}

/** A stretch on foot or by bike. */
export interface MoveLeg {
  mode: "walk" | "bike";
  coordinates: LngLat[];
  meters: number;
  seconds: number;
  stairSegments: number;
  /** Bike legs: meters where the bike has to be walked (footpaths, stairs). */
  pushMeters: number;
  /** Graph node at each coordinate (-1 at a shuttle stop). */
  nodes: number[];
  /** Graph edge between consecutive coordinates (-1 for the walk to/from a stop). */
  edges: number[];
}

export interface BusLeg {
  mode: "bus";
  coordinates: LngLat[];
  route: TransitRoute;
  headsign: string;
  from: TransitStop;
  to: TransitStop;
  stopCount: number;
  departs: Date;
  arrives: Date;
  /** Timetable pattern and the boarding position in it (for "every N min"). */
  pattern: number;
  fromPos: number;
}

export type Leg = MoveLeg | BusLeg;

export interface Route {
  legs: Leg[];
  coordinates: LngLat[];
  /** Distance travelled on foot or by bike (not on the bus). */
  meters: number;
  /** Door to door, including waiting for a shuttle. */
  minutes: number;
  /** The same, in seconds (what comparisons between routes use). */
  seconds: number;
  stairSegments: number;
  leaveAt: Date;
  arriveAt: Date;
  usesTransit: boolean;
}

/** Arrive at the stop this early; a bus that leaves sooner is missed. */
const BOARD_BUFFER_S = 60;
/** Extra perceived cost per boarding: a nudge against needless transfers. */
const BOARD_PENALTY_S = 60;
/** Upper bound on travel speed for the heuristic when riding a shuttle is allowed. */
const MAX_TRANSIT_SPEED_MPS = 25;

type Step =
  | { kind: "edge"; edge: number }
  | { kind: "toStop" }
  | { kind: "fromStop" }
  | { kind: "ride"; pattern: number; trip: number; fromPos: number; toPos: number };

/**
 * Time-dependent A* from `start` (one node, or any of several, e.g. a building's
 * exits) to whichever of `targets` is reached first, walking or riding the graph
 * and (optionally) taking shuttles on their timetable.
 *
 * A route may cut across open ground between paths only when that's worth it for the trip
 * as a whole (GAP_MIN_SAVING); otherwise it stays on the paths.
 */
export function findRoute(
  graph: CampusGraph,
  start: number | number[],
  targets: number[],
  opts: RouteOptions = {},
): Route | null {
  const across = search(graph, start, targets, opts);
  if (!across || opts.noGaps || !usesGap(graph, across)) return across;
  const onPaths = search(graph, start, targets, { ...opts, noGaps: true });
  if (!onPaths) return across;
  const saved = onPaths.seconds - across.seconds;
  return saved >= Math.max(GAP_MIN_SAVING.seconds, GAP_MIN_SAVING.share * onPaths.seconds) ? across : onPaths;
}

/** Whether the route cuts across open ground anywhere. */
export function usesGap(graph: CampusGraph, route: Route): boolean {
  return route.legs.some((l) => l.mode !== "bus" && l.edges.some((e) => e >= 0 && graph.kind(e) === EdgeKind.Gap));
}

function search(graph: CampusGraph, start: number | number[], targets: number[], opts: RouteOptions): Route | null {
  const starts = Array.isArray(start) ? start : [start];
  const profile: Profile = opts.profile ?? PROFILES.walk;
  // Shuttles are only combined with walking.
  const transit = profile.travel === "walk" ? (opts.transit ?? null) : null;
  const departAt = opts.departAt ?? new Date();
  const walkWeight = transit ? (opts.walkWeight ?? 1) : 1;
  const boardPenalty = opts.boardPenalty ?? BOARD_PENALTY_S;
  if (targets.length === 0 || starts.length === 0) return null;

  const n = graph.nodeCount;
  const total = n + (transit?.data.stops.length ?? 0); // stop s is search node n + s
  const pos = (i: number): LngLat => (i < n ? graph.coord(i) : transit!.data.stops[i - n].lngLat);

  const targetSet = new Set(targets);
  const tLon = targets.map((t) => graph.lon[t]);
  const tLat = targets.map((t) => graph.lat[t]);
  const fastest = transit ? MAX_TRANSIT_SPEED_MPS : Math.max(...Object.values(profile.speed));
  const heuristic = (i: number) => {
    const [lon, lat] = pos(i);
    let best = Infinity;
    for (let k = 0; k < targets.length; k++) best = Math.min(best, haversine(lon, lat, tLon[k], tLat[k]));
    return best / fastest;
  };

  const base = secondsSinceMidnight(departAt);
  const services = transit?.activeServices(departAt);
  const cost = new Float64Array(total).fill(Infinity); // seconds incl. preferences/penalties: what we minimise
  const clock = new Float64Array(total).fill(Infinity); // seconds after departure: when you're actually there
  const prev = new Int32Array(total).fill(-1);
  const step: (Step | undefined)[] = new Array(total);
  const closed = new Uint8Array(total);
  const open = new MinHeap();

  const relax = (v: number, from: number, c: number, t: number, s: Step) => {
    if (closed[v] || c >= cost[v]) return;
    cost[v] = c;
    clock[v] = t;
    prev[v] = from;
    step[v] = s;
    open.push(v, c + heuristic(v));
  };

  for (const s of starts) {
    const c0 = (opts.startCost?.get(s) ?? 0) * walkWeight;
    if (c0 >= cost[s]) continue;
    cost[s] = c0;
    clock[s] = 0;
    open.push(s, c0 + heuristic(s));
  }

  // The best target so far, counting what's left from it; done once nothing open can beat it.
  let reached = -1;
  let bestTotal = Infinity;
  while (open.size > 0) {
    const u = open.pop();
    if (closed[u]) continue;
    if (cost[u] + heuristic(u) >= bestTotal) break;
    closed[u] = 1;
    if (targetSet.has(u)) {
      const total = cost[u] + (opts.targetCost?.get(u) ?? 0) * walkWeight;
      if (total < bestTotal) {
        bestTotal = total;
        reached = u;
      }
      if (!opts.targetCost) break;
    }

    if (u < n) {
      for (let k = graph.adjStart[u]; k < graph.adjStart[u + 1]; k++) {
        const e = graph.adjEdge[k];
        if (opts.noGaps && graph.kind(e) === EdgeKind.Gap) continue;
        const { speed, prefer } = edgeTravel(graph, profile, e, u);
        if (!speed) continue;
        const dt = graph.edgeLength[e] / speed;
        const c = cost[u] + dt * prefer * walkWeight;
        relax(graph.other(e, u), u, c, clock[u] + dt, { kind: "edge", edge: e });
      }
      for (const { stop, meters } of transit?.nodeStops.get(u) ?? []) {
        const dt = meters / WALKING_SPEED_MPS;
        relax(n + stop, u, cost[u] + dt * walkWeight, clock[u] + dt, { kind: "toStop" });
      }
      continue;
    }

    // At a stop: walk back onto the network, or board the next departure of each pattern.
    const s = u - n;
    const net = transit!;
    const walkOff = net.stopWalkMeters[s] / WALKING_SPEED_MPS;
    relax(net.data.stops[s].node, u, cost[u] + walkOff * walkWeight, clock[u] + walkOff, { kind: "fromStop" });
    const ready = base + clock[u] + BOARD_BUFFER_S;
    for (const { pattern, pos: p } of net.stopPatterns[s]) {
      const pat = net.data.patterns[pattern];
      if (p === pat.stops.length - 1) continue;
      const trip = pat.trips.findIndex((tr) => services!.has(tr.service) && tr.times[p] >= ready);
      if (trip === -1) continue;
      const times = pat.trips[trip].times;
      for (let q = p + 1; q < pat.stops.length; q++) {
        const t = times[q] - base;
        const c = cost[u] + (t - clock[u]) + boardPenalty;
        relax(n + pat.stops[q], u, c, t, { kind: "ride", pattern, trip, fromPos: p, toPos: q });
      }
    }
  }
  if (reached === -1) return null;

  // Walk the chain back to whichever start it came from.
  const chain: { node: number; step: Step }[] = [];
  let v = reached;
  for (; prev[v] !== -1; v = prev[v]) chain.push({ node: v, step: step[v]! });
  chain.reverse();
  return buildRoute(graph, transit, profile, v, chain, departAt, pos);
}

function buildRoute(
  graph: CampusGraph,
  transit: TransitNetwork | null,
  profile: Profile,
  start: number,
  chain: { node: number; step: Step }[],
  departAt: Date,
  pos: (i: number) => LngLat,
): Route {
  const legs: Leg[] = [];
  let move: MoveLeg | null = null;
  let last = start;
  const midnight = new Date(departAt);
  midnight.setHours(0, 0, 0, 0);
  const at = (secondsOfDay: number) => new Date(midnight.getTime() + secondsOfDay * 1000);
  const n = graph.nodeCount;
  const newMove = (fromNode: number): MoveLeg => ({
    mode: profile.travel,
    coordinates: [pos(fromNode)],
    meters: 0,
    seconds: 0,
    stairSegments: 0,
    pushMeters: 0,
    nodes: [fromNode < n ? fromNode : -1],
    edges: [],
  });

  for (const { node, step } of chain) {
    if (step.kind === "ride") {
      move = null;
      const net = transit!;
      const pat = net.data.patterns[step.pattern];
      const times = pat.trips[step.trip].times;
      legs.push({
        mode: "bus",
        coordinates: pat.shape.slice(pat.shapeIndex[step.fromPos], pat.shapeIndex[step.toPos] + 1),
        route: net.data.routes[pat.route],
        headsign: pat.headsign,
        from: net.data.stops[pat.stops[step.fromPos]],
        to: net.data.stops[pat.stops[step.toPos]],
        stopCount: step.toPos - step.fromPos,
        departs: at(times[step.fromPos]),
        arrives: at(times[step.toPos]),
        pattern: step.pattern,
        fromPos: step.fromPos,
      });
    } else {
      if (!move) legs.push((move = newMove(last)));
      const [a, b] = [pos(last), pos(node)];
      if (step.kind === "edge") {
        const kind = graph.kind(step.edge);
        const meters = graph.edgeLength[step.edge];
        const { speed } = edgeTravel(graph, profile, step.edge, last);
        move.meters += meters;
        move.seconds += meters / speed;
        move.stairSegments += kind === EdgeKind.Steps ? 1 : 0;
        if (profile.travel === "bike" && speed < PUSH_THRESHOLD) move.pushMeters += meters;
        move.edges.push(step.edge);
      } else {
        move.edges.push(-1);
        // Walking to or from a shuttle stop.
        const meters = haversine(a[0], a[1], b[0], b[1]);
        move.meters += meters;
        move.seconds += meters / WALKING_SPEED_MPS;
      }
      move.coordinates.push(b);
      move.nodes.push(node < n ? node : -1);
    }
    last = node;
  }
  if (legs.length === 0) legs.push(newMove(start));
  mergeStayOnBoard(legs);

  // Timeline: travel before the first bus is timed backwards from its departure.
  const firstBus = legs.findIndex((l) => l.mode === "bus");
  let leaveAt: Date;
  if (firstBus === -1) {
    leaveAt = departAt;
  } else {
    const before = legs.slice(0, firstBus).reduce((s, l) => s + (l as MoveLeg).seconds, 0);
    leaveAt = new Date((legs[firstBus] as BusLeg).departs.getTime() - (before + BOARD_BUFFER_S) * 1000);
  }
  let t = leaveAt.getTime();
  for (const leg of legs) t = leg.mode === "bus" ? leg.arrives.getTime() : t + leg.seconds * 1000;
  const arriveAt = new Date(t);

  const moves = legs.filter((l): l is MoveLeg => l.mode !== "bus");
  return {
    legs,
    coordinates: legs.flatMap((l) => l.coordinates),
    meters: moves.reduce((s, l) => s + l.meters, 0),
    minutes: (arriveAt.getTime() - leaveAt.getTime()) / 60_000,
    seconds: (arriveAt.getTime() - leaveAt.getTime()) / 1000,
    stairSegments: moves.reduce((s, l) => s + l.stairSegments, 0),
    leaveAt,
    arriveAt,
    usesTransit: firstBus !== -1,
  };
}

/**
 * A loop shuttle that finishes its run and starts the next one at the same stop
 * shows up as two rides on the same route: present it as one ("stay on board").
 */
function mergeStayOnBoard(legs: Leg[]): void {
  for (let i = legs.length - 1; i > 0; i--) {
    const [a, b] = [legs[i - 1], legs[i]];
    if (a.mode === "bus" && b.mode === "bus" && a.route.id === b.route.id && a.to.id === b.from.id) {
      legs.splice(i - 1, 2, {
        ...a,
        coordinates: [...a.coordinates, ...b.coordinates],
        headsign: b.headsign,
        to: b.to,
        stopCount: a.stopCount + b.stopCount,
        arrives: b.arrives,
      });
    }
  }
}

/**
 * Latest-departure route that still arrives by `arriveBy`. Walking-only routes
 * are timed backwards directly; with shuttles we binary-search the departure time.
 */
export function findRouteArriveBy(
  graph: CampusGraph,
  start: number | number[],
  targets: number[],
  arriveBy: Date,
  opts: Omit<RouteOptions, "departAt"> = {},
): Route | null {
  const walkOnly = findRoute(graph, start, targets, {
    profile: opts.profile,
    departAt: arriveBy,
    startCost: opts.startCost,
    targetCost: opts.targetCost,
  });
  const shiftTo = (r: Route, leave: Date): Route => {
    const dt = leave.getTime() - r.leaveAt.getTime();
    return { ...r, leaveAt: leave, arriveAt: new Date(r.arriveAt.getTime() + dt) };
  };
  const walking = walkOnly && shiftTo(walkOnly, new Date(arriveBy.getTime() - walkOnly.seconds * 1000));
  if (!opts.transit) return walking;

  // Latest departure within the last 3 hours whose route still arrives in time.
  let lo = arriveBy.getTime() - 3 * 3600_000;
  let hi = arriveBy.getTime();
  let best: Route | null = null;
  for (let i = 0; i < 12 && hi - lo > 30_000; i++) {
    const mid = (lo + hi) / 2;
    const r = findRoute(graph, start, targets, { ...opts, departAt: new Date(mid) });
    if (r && r.arriveAt <= arriveBy) {
      best = r;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (!best) return walking;
  if (!best.usesTransit) best = walking ?? best;
  // When walking more is deliberately penalised, keep the transit route the search chose.
  if ((opts.walkWeight ?? 1) > 1) return best;
  // Fastest trip: prefer whichever lets you leave later.
  return walking && walking.leaveAt >= best.leaveAt ? walking : best;
}
