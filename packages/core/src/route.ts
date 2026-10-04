import { WALKING_SPEED_MPS, haversine } from "./geo.ts";
import type { CampusGraph } from "./graph.ts";
import { secondsSinceMidnight, type TransitNetwork, type TransitRoute, type TransitStop } from "./transit.ts";
import { EdgeKind, type LngLat } from "./types.ts";

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
}

const WALK = WALKING_SPEED_MPS;
/** Typical relaxed campus cycling speed (~18 km/h). */
const RIDE = 5;
/** Riding slowly among pedestrians on shared paths. */
const RIDE_SHARED = 3.5;
/** Walking a bike where riding isn't allowed. */
const PUSH = 1.2;

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
      // Climbing stairs is slower than walking the same distance on the flat.
      [EdgeKind.Steps]: WALK / 1.4,
      [EdgeKind.BikeOnly]: 0,
    },
    // Prefer footpaths; connector roads only when nothing else goes there.
    prefer: { [EdgeKind.Bike]: 1.1, [EdgeKind.Road]: 1.5 },
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
      [EdgeKind.Steps]: 0,
      [EdgeKind.BikeOnly]: 0,
    },
    prefer: { [EdgeKind.Bike]: 1.1, [EdgeKind.Road]: 1.5 },
  },
  bike: {
    id: "bike",
    label: "Bike",
    travel: "bike",
    speed: {
      [EdgeKind.Bike]: RIDE,
      [EdgeKind.Road]: RIDE,
      [EdgeKind.BikeOnly]: RIDE,
      [EdgeKind.Shared]: RIDE_SHARED,
      // Footpaths and hand-traced paths: get off and walk the bike.
      [EdgeKind.Path]: PUSH,
      [EdgeKind.Custom]: PUSH,
      // Carrying a bike up or down stairs: possible, but only as a last resort.
      [EdgeKind.Steps]: 0.4,
    },
    // Bike paths first, then quiet shared paths, then roads.
    prefer: { [EdgeKind.Road]: 1.15, [EdgeKind.BikeOnly]: 1.2, [EdgeKind.Shared]: 1.05, [EdgeKind.Steps]: 3 },
  },
} satisfies Record<string, Profile>;

export type ProfileId = keyof typeof PROFILES;

/** The commute options offered in the app. */
export const MODES = {
  walk: { label: "Walk", profile: PROFILES.walk, transit: false, walkWeight: 1 },
  accessible: { label: "No stairs", profile: PROFILES.accessible, transit: false, walkWeight: 1 },
  bike: { label: "Bike", profile: PROFILES.bike, transit: false, walkWeight: 1 },
  // Bus mode is for people who'd rather not walk: it minimises walking, not total time.
  bus: { label: "Bus", profile: PROFILES.walk, transit: true, walkWeight: 10 },
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
}

export type Leg = MoveLeg | BusLeg;

export interface Route {
  legs: Leg[];
  coordinates: LngLat[];
  /** Distance travelled on foot or by bike (not on the bus). */
  meters: number;
  /** Door to door, including waiting for a shuttle. */
  minutes: number;
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
 */
export function findRoute(
  graph: CampusGraph,
  start: number | number[],
  targets: number[],
  opts: RouteOptions = {},
): Route | null {
  const starts = Array.isArray(start) ? start : [start];
  const profile: Profile = opts.profile ?? PROFILES.walk;
  // Shuttles are only combined with walking.
  const transit = profile.travel === "walk" ? (opts.transit ?? null) : null;
  const departAt = opts.departAt ?? new Date();
  const walkWeight = transit ? (opts.walkWeight ?? 1) : 1;
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
    cost[s] = 0;
    clock[s] = 0;
    open.push(s, heuristic(s));
  }

  let reached = -1;
  while (open.size > 0) {
    const u = open.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (targetSet.has(u)) {
      reached = u;
      break;
    }

    if (u < n) {
      for (let k = graph.adjStart[u]; k < graph.adjStart[u + 1]; k++) {
        const e = graph.adjEdge[k];
        const kind = graph.kind(e);
        const speed = profile.speed[kind];
        if (!speed) continue;
        const dt = graph.edgeLength[e] / speed;
        const c = cost[u] + dt * (profile.prefer?.[kind] ?? 1) * walkWeight;
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
        const c = cost[u] + (t - clock[u]) + BOARD_PENALTY_S;
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
  const newMove = (from: LngLat): MoveLeg => ({
    mode: profile.travel,
    coordinates: [from],
    meters: 0,
    seconds: 0,
    stairSegments: 0,
    pushMeters: 0,
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
      });
    } else {
      if (!move) legs.push((move = newMove(pos(last))));
      const [a, b] = [pos(last), pos(node)];
      if (step.kind === "edge") {
        const kind = graph.kind(step.edge);
        const meters = graph.edgeLength[step.edge];
        const speed = profile.speed[kind];
        move.meters += meters;
        move.seconds += meters / speed;
        move.stairSegments += kind === EdgeKind.Steps ? 1 : 0;
        if (profile.travel === "bike" && speed < PUSH_THRESHOLD) move.pushMeters += meters;
      } else {
        // Walking to or from a shuttle stop.
        const meters = haversine(a[0], a[1], b[0], b[1]);
        move.meters += meters;
        move.seconds += meters / WALKING_SPEED_MPS;
      }
      move.coordinates.push(b);
    }
    last = node;
  }
  if (legs.length === 0) legs.push(newMove(pos(start)));
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
  const walkOnly = findRoute(graph, start, targets, { profile: opts.profile, departAt: arriveBy });
  const shiftTo = (r: Route, leave: Date): Route => {
    const dt = leave.getTime() - r.leaveAt.getTime();
    return { ...r, leaveAt: leave, arriveAt: new Date(r.arriveAt.getTime() + dt) };
  };
  const walking = walkOnly && shiftTo(walkOnly, new Date(arriveBy.getTime() - walkOnly.minutes * 60_000));
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
  // Minimising walking: the search already chose the bus over walking on purpose.
  if ((opts.walkWeight ?? 1) > 1) return best;
  // Fastest trip: prefer whichever lets you leave later.
  return walking && walking.leaveAt >= best.leaveAt ? walking : best;
}

/** Binary min-heap of (node, priority) with lazy deletion handled by the caller. */
class MinHeap {
  private nodes: number[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, prio: number): void {
    const { nodes, prios } = this;
    let i = nodes.length;
    nodes.push(node);
    prios.push(prio);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prios[parent] <= prio) break;
      nodes[i] = nodes[parent];
      prios[i] = prios[parent];
      i = parent;
    }
    nodes[i] = node;
    prios[i] = prio;
  }

  pop(): number {
    const { nodes, prios } = this;
    const top = nodes[0];
    const lastNode = nodes.pop()!;
    const lastPrio = prios.pop()!;
    const len = nodes.length;
    if (len > 0) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        if (l >= len) break;
        const r = l + 1;
        const c = r < len && prios[r] < prios[l] ? r : l;
        if (prios[c] >= lastPrio) break;
        nodes[i] = nodes[c];
        prios[i] = prios[c];
        i = c;
      }
      nodes[i] = lastNode;
      prios[i] = lastPrio;
    }
    return top;
  }
}
