import type { CampusGraph } from "./graph.ts";
import { approachCosts, attachEnds, resolveTrip, type Endpoint } from "./plan.ts";
import { PROFILES, findRoute, findRouteArriveBy, type BusLeg, type Route, type RouteOptions } from "./route.ts";
import type { TransitNetwork } from "./transit.ts";
import type { LngLat } from "./types.ts";

/** Like Google Maps' route options. */

export interface Timing {
  departAt?: Date;
  arriveBy?: Date;
}

/** One choice in the Transit list (walking can be one of them, as in Google Maps). */
export interface TransitOption {
  route: Route;
  /** Just walking, no transit. */
  walkOnly: boolean;
  /** A later (or earlier, when arriving by a time) run of a route already listed. */
  alternateTime: boolean;
  boardings: number;
  walkMeters: number;
  walkMinutes: number;
}

export interface TransitOptionsResult {
  options: TransitOption[];
  connectors: [LngLat, LngLat][];
  error?: string;
}

/**
 * Searches with different trade-offs, each a (walk weight, boarding penalty)
 * pair: fastest, a little less walking, much less walking, fewest transfers.
 */
const VARIANTS: Pick<RouteOptions, "walkWeight" | "boardPenalty">[] = [
  { walkWeight: 1, boardPenalty: 60 },
  { walkWeight: 2.5, boardPenalty: 60 },
  { walkWeight: 8, boardPenalty: 60 },
  { walkWeight: 1.5, boardPenalty: 900 },
];
/** How many later (or earlier) departures of the best route to add. */
const ALTERNATE_TIMES = 2;

/**
 * Transit choices for a trip, Google-Maps style: several routes that trade off
 * arrival time, transfers and walking (dominated ones dropped), walking itself
 * when it's competitive, and the next departures of the best route: the
 * shortest trips first, at most `max` (3).
 */
export function transitOptions(
  graph: CampusGraph,
  from: Endpoint,
  to: Endpoint,
  opts: { transit: TransitNetwork; timing: Timing; stepFree?: boolean; max?: number },
): TransitOptionsResult {
  const profile = opts.stepFree ? PROFILES.accessible : PROFILES.walk;
  const trip = resolveTrip(graph, from, to, profile);
  if (!trip.ok) return { options: [], connectors: [], error: trip.error };
  const arriveBy = opts.timing.arriveBy;
  const departAt = opts.timing.departAt ?? new Date();

  // A free start or end can go either way along the path it joins.
  const costs = approachCosts(graph, trip.ends, profile);
  const run = (variant: (typeof VARIANTS)[number], at: Date, mode: "depart" | "arrive") =>
    mode === "arrive"
      ? findRouteArriveBy(graph, trip.start, trip.targets, at, { profile, transit: opts.transit, ...costs, ...variant })
      : findRoute(graph, trip.start, trip.targets, { profile, transit: opts.transit, departAt: at, ...costs, ...variant });

  const found: TransitOption[] = [];
  const add = (raw: Route | null, alternateTime = false) => {
    if (!raw) return;
    // Out to where free points actually meet the network.
    const route = attachEnds(graph, raw, trip.ends, profile);
    const option = describe(route, alternateTime);
    if (!found.some((o) => key(o) === key(option))) found.push(option);
  };

  for (const v of VARIANTS) add(run(v, arriveBy ?? departAt, arriveBy ? "arrive" : "depart"));

  // Walking, for comparison (Google lists it among transit options when it's competitive).
  const walk = arriveBy
    ? findRouteArriveBy(graph, trip.start, trip.targets, arriveBy, { profile, ...costs })
    : findRoute(graph, trip.start, trip.targets, { profile, departAt, ...costs });
  add(walk);

  // Next departures of the fastest transit route (or earlier ones, arriving by a time).
  let anchor = found.find((o) => !o.walkOnly)?.route;
  for (let i = 0; i < ALTERNATE_TIMES && anchor; i++) {
    const next = arriveBy
      ? run(VARIANTS[0], new Date(anchor.arriveAt.getTime() - 60_000), "arrive")
      : run(VARIANTS[0], new Date(anchor.leaveAt.getTime() + 60_000), "depart");
    if (!next?.usesTransit || key(describe(next, true)) === key(describe(anchor, true))) break;
    add(next, true);
    anchor = next;
  }

  // Walking stays in the list only when it's competitive with the best transit option,
  // judged by when you'd arrive (leaving now) or have to leave (arriving by a time),
  // since a short ride can involve a long wait.
  const transitOnes = found.filter((o) => !o.walkOnly);
  const start = (arriveBy ?? departAt).getTime();
  const span = (o: TransitOption) => (arriveBy ? start - o.route.leaveAt.getTime() : o.route.arriveAt.getTime() - start) / 60_000;
  const bestSpan = Math.min(...transitOnes.map(span));
  const keep = (o: TransitOption) => !o.walkOnly || !transitOnes.length || span(o) <= bestSpan * 1.25 + 3;
  // Later runs of a line already listed go at the end ("later departures"); anything
  // else found while looking for them competes like any other option.
  const listedLines = new Set(found.filter((o) => !o.alternateTime).map(lines));
  for (const o of found) if (o.alternateTime && !listedLines.has(lines(o))) o.alternateTime = false;
  const main = paretoFilter(found.filter((o) => !o.alternateTime && keep(o)), !!arriveBy);
  const later = found.filter((o) => o.alternateTime);
  return { options: byDuration([...main, ...later], !!arriveBy).slice(0, opts.max ?? 3), connectors: trip.connectors };
}

function describe(route: Route, alternateTime: boolean): TransitOption {
  const moves = route.legs;
  return {
    route,
    walkOnly: !route.usesTransit,
    alternateTime,
    boardings: route.legs.filter((l) => l.mode === "bus").length,
    walkMeters: route.meters,
    walkMinutes: moves.reduce((s, l) => s + (l.mode === "bus" ? 0 : (l as { seconds: number }).seconds), 0) / 60,
  };
}

/** Same lines boarded at the same times = same option. */
function key(o: TransitOption): string {
  if (o.walkOnly) return "walk";
  return o.route.legs
    .filter((l): l is BusLeg => l.mode === "bus")
    .map((l) => `${l.route.id}@${l.departs.getTime()}`)
    .join("|");
}

/** The lines ridden, ignoring times. */
function lines(o: TransitOption): string {
  return o.walkOnly ? "walk" : o.route.legs.flatMap((l) => (l.mode === "bus" ? [l.route.id] : [])).join(">");
}

/** Drop options another option beats on time, transfers and walking at once. */
function paretoFilter(options: TransitOption[], arriveBy: boolean): TransitOption[] {
  const time = (o: TransitOption) => (arriveBy ? -o.route.leaveAt.getTime() : o.route.arriveAt.getTime());
  return options.filter(
    (o) =>
      !options.some(
        (p) =>
          p !== o &&
          time(p) <= time(o) &&
          p.boardings <= o.boardings &&
          p.walkMeters <= o.walkMeters + 1 &&
          (time(p) < time(o) || p.boardings < o.boardings || p.walkMeters < o.walkMeters - 1),
      ),
  );
}

/** Shortest trip first (door to door, waits included); on a tie, the one that gets you there first. */
function byDuration(options: TransitOption[], arriveBy: boolean): TransitOption[] {
  // Leaving now: earliest arrival. Arriving by a time: latest departure.
  const time = (o: TransitOption) => (arriveBy ? -o.route.leaveAt.getTime() : o.route.arriveAt.getTime());
  return [...options].sort((a, b) => a.route.minutes - b.route.minutes || time(a) - time(b) || a.boardings - b.boardings);
}

/** How often a ride's line leaves that stop around that time ("every 12 min"), if it's regular. */
export function headwayMinutes(transit: TransitNetwork, leg: BusLeg, windowMin = 60): number | null {
  const pat = transit.data.patterns[leg.pattern];
  if (!pat) return null;
  const services = transit.activeServices(leg.departs);
  const midnight = new Date(leg.departs);
  midnight.setHours(0, 0, 0, 0);
  const t = (leg.departs.getTime() - midnight.getTime()) / 1000;
  const times = pat.trips
    .filter((tr) => services.has(tr.service))
    .map((tr) => tr.times[leg.fromPos])
    .filter((x) => Math.abs(x - t) <= windowMin * 60)
    .sort((a, b) => a - b);
  if (times.length < 3) return null;
  const gaps = times.slice(1).map((x, i) => x - times[i]).sort((a, b) => a - b);
  return Math.round(gaps[gaps.length >> 1] / 60);
}

/** The next few departures of a ride's line from its boarding stop, after the one in the route. */
export function nextDepartures(transit: TransitNetwork, leg: BusLeg, count = 2): Date[] {
  const pat = transit.data.patterns[leg.pattern];
  if (!pat) return [];
  const services = transit.activeServices(leg.departs);
  const midnight = new Date(leg.departs);
  midnight.setHours(0, 0, 0, 0);
  const t = (leg.departs.getTime() - midnight.getTime()) / 1000;
  return pat.trips
    .filter((tr) => services.has(tr.service) && tr.times[leg.fromPos] > t)
    .map((tr) => tr.times[leg.fromPos])
    .sort((a, b) => a - b)
    .slice(0, count)
    .map((sec) => new Date(midnight.getTime() + sec * 1000));
}
