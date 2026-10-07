import { distanceMeters } from "./geo.ts";
import type { CampusGraph } from "./graph.ts";
import type { BusLeg, MoveLeg, Route } from "./route.ts";
import { routeLabel } from "./transit.ts";
import { BikeDir, EdgeKind, type LngLat } from "./types.ts";

export type Maneuver =
  | "depart"
  | "straight"
  | "slight-left"
  | "slight-right"
  | "left"
  | "right"
  | "sharp-left"
  | "sharp-right"
  | "stairs"
  | "walk-bike"
  | "ride-bike"
  | "board"
  | "alight"
  | "arrive";

/** One turn-by-turn instruction. */
export interface Step {
  maneuver: Maneuver;
  text: string;
  /** Where the instruction applies. */
  at: LngLat;
  /** Meters from the start of the route (along `route.coordinates`) to `at`. */
  along: number;
  /** Meters until the next instruction. */
  distance: number;
}

/** Look this far either side of a junction to judge the turn, so small wiggles don't count. */
const BEARING_WINDOW_M = 12;
/** Turns smaller than this at a junction are "continue". */
const TURN_DEG = 35;
/** Steps closer together than this are merged (keeps "turn left, then turn right" out of 3 m bits). */
const MIN_STEP_M = 8;
/** Footpath stretches shorter than this don't get "walk your bike" instructions. */
const MIN_PUSH_M = 25;

/** Turn-by-turn instructions for a route, Google-Maps style. */
export function buildSteps(graph: CampusGraph, route: Route, destination: string): Step[] {
  const steps: Step[] = [];
  let offset = 0; // meters along route.coordinates where the current leg starts

  route.legs.forEach((leg, li) => {
    const next = route.legs[li + 1];
    if (leg.mode === "bus") {
      busSteps(leg, offset).forEach((s) => steps.push(s));
    } else {
      moveSteps(graph, leg, offset, li === 0, next?.mode === "bus" ? next.from.name : null).forEach((s) => steps.push(s));
    }
    offset += polylineLength(leg.coordinates);
    // route.coordinates runs legs together, including the hop between them.
    if (next?.coordinates.length && leg.coordinates.length) {
      offset += distanceMeters(leg.coordinates[leg.coordinates.length - 1], next.coordinates[0]);
    }
  });

  const end = route.coordinates[route.coordinates.length - 1];
  steps.push({ maneuver: "arrive", text: `Arrive at ${destination}`, at: end, along: offset, distance: 0 });
  // A turn a few meters before arriving is noise.
  while (steps.length > 2) {
    const before = steps[steps.length - 2];
    if (!["depart", "board", "alight"].includes(before.maneuver) && offset - before.along < MIN_STEP_M) steps.splice(steps.length - 2, 1);
    else break;
  }
  // Distances between consecutive instructions.
  for (let i = 0; i < steps.length - 1; i++) steps[i].distance = Math.max(0, steps[i + 1].along - steps[i].along);
  return steps;
}

function moveSteps(graph: CampusGraph, leg: MoveLeg, offset: number, first: boolean, toStop: string | null): Step[] {
  const c = leg.coordinates;
  if (c.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + distanceMeters(c[i - 1], c[i]));

  const name = (i: number) => (leg.edges[i] >= 0 ? graph.edgeName(leg.edges[i]) : undefined); // edge i: c[i] -> c[i+1]
  const kind = (i: number) => (leg.edges[i] >= 0 ? graph.kind(leg.edges[i]) : EdgeKind.Path);
  const bike = leg.mode === "bike";
  // The wrong way down a one-way: no riding (cyclists keep right), so walk it.
  const against = (i: number) => {
    const e = leg.edges[i];
    if (e < 0) return false;
    const forward = graph.edgeFrom[e] === leg.nodes[i];
    return (graph.edgeBikeDir[e] & (forward ? BikeDir.NoForward : BikeDir.NoBackward)) !== 0;
  };
  const rawPush = (i: number) =>
    bike && (kind(i) === EdgeKind.Path || kind(i) === EdgeKind.Custom || kind(i) === EdgeKind.Steps || against(i));
  // Only stretches of footpath long enough to matter get "walk your bike" instructions.
  const pushRun: boolean[] = [];
  for (let i = 0; i < c.length - 1; ) {
    let j = i;
    while (j < c.length - 1 && rawPush(j) === rawPush(i)) j++;
    const long = cum[j] - cum[i] >= MIN_PUSH_M;
    for (let k = i; k < j; k++) pushRun[k] = rawPush(i) && long;
    i = j;
  }
  const pushing = (i: number) => pushRun[i] ?? false;

  const out: Step[] = [];
  const headBearing = bearingAround(c, cum, 0, 1);
  const verb = bike ? (pushing(0) ? "Walk your bike" : "Ride") : "Head";
  const on = name(0) ? ` on ${name(0)}` : "";
  out.push({
    maneuver: "depart",
    text: toStop && !first ? `Walk to ${toStop}` : `${verb} ${compass(headBearing)}${on}${toStop ? ` toward ${toStop}` : ""}`,
    at: c[0],
    along: offset,
    distance: 0,
  });

  for (let i = 1; i < c.length - 1; i++) {
    const prevKind = kind(i - 1);
    const nextKind = kind(i);
    const along = offset + cum[i];

    // Stairs and getting off / back on the bike are always worth saying.
    if (nextKind === EdgeKind.Steps && prevKind !== EdgeKind.Steps) {
      push(out, { maneuver: "stairs", text: bike ? "Carry your bike up/down the stairs" : "Take the stairs", at: c[i], along });
      continue;
    }
    if (bike && pushing(i) && !pushing(i - 1) && nextKind !== EdgeKind.Steps) {
      const where = against(i)
        ? `${kind(i) === EdgeKind.Sidewalk ? " on the sidewalk" : ""}${name(i) ? ` along ${name(i)}` : ""} (one-way the other way)`
        : name(i)
          ? ` along ${name(i)}`
          : " on the footpath";
      push(out, { maneuver: "walk-bike", text: `Get off and walk your bike${where}`, at: c[i], along });
      continue;
    }
    if (bike && !pushing(i) && pushing(i - 1)) {
      push(out, { maneuver: "ride-bike", text: `Get back on your bike${name(i) ? ` on ${name(i)}` : ""}`, at: c[i], along });
      continue;
    }

    // Turns: only where paths meet (no choice = no instruction), or where the name changes.
    const node = leg.nodes[i];
    const junction = node >= 0 && graph.degree(node) >= 3;
    const renamed = !!name(i) && name(i) !== name(i - 1);
    if (!junction && !renamed) continue;
    const turn = normalize(bearingAround(c, cum, i, 1) - bearingAround(c, cum, i, -1));
    const m = maneuverFor(turn);
    if (m === "straight" && !renamed) continue;
    const stay = !renamed && !!name(i) && name(i) === name(i - 1);
    const onto = stay
      ? ` to stay on ${name(i)}`
      : name(i)
        ? ` onto ${name(i)}`
        : kind(i) === EdgeKind.Bike
          ? " onto the bike path"
          : nextKind === EdgeKind.Road
            ? " onto the road"
            : "";
    const text = m === "straight" ? `Continue${onto || " straight"}` : `${turnWords(m)}${onto}`;
    push(out, { maneuver: m, text, at: c[i], along });
  }
  return out;
}

function busSteps(leg: BusLeg, offset: number): Step[] {
  const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const end = leg.coordinates[leg.coordinates.length - 1] ?? leg.to.lngLat;
  return [
    {
      maneuver: "board",
      text: `Board the ${routeLabel(leg.route)}${leg.headsign && leg.headsign !== leg.route.long ? ` toward ${leg.headsign}` : ""} at ${time(leg.departs)}`,
      at: leg.from.lngLat,
      along: offset,
      distance: 0,
    },
    {
      maneuver: "alight",
      text: `Get off at ${leg.to.name} (${leg.stopCount} stop${leg.stopCount > 1 ? "s" : ""}, ${time(leg.arrives)})`,
      at: end,
      along: offset + polylineLength(leg.coordinates),
      distance: 0,
    },
  ];
}

/** Add a step, folding it into the previous one if they're only a few meters apart. */
function push(out: Step[], step: Omit<Step, "distance">) {
  const prev = out[out.length - 1];
  if (prev && prev.maneuver !== "depart" && step.along - prev.along < MIN_STEP_M) {
    // Two instructions a few meters apart: keep the earlier one unless the later
    // one is the real turn (not just "continue"/"stay on").
    const minor = step.maneuver === "straight" || step.text.includes("to stay on");
    if (!minor) out[out.length - 1] = { ...step, distance: 0 };
    return;
  }
  out.push({ ...step, distance: 0 });
}

function maneuverFor(turn: number): Maneuver {
  const a = Math.abs(turn);
  const side = turn < 0 ? "left" : "right";
  if (a < TURN_DEG) return "straight";
  if (a < 60) return `slight-${side}`;
  if (a < 140) return side;
  return `sharp-${side}`;
}

function turnWords(m: Maneuver): string {
  switch (m) {
    case "slight-left":
      return "Bear left";
    case "slight-right":
      return "Bear right";
    case "left":
      return "Turn left";
    case "right":
      return "Turn right";
    case "sharp-left":
      return "Turn sharp left";
    case "sharp-right":
      return "Turn sharp right";
    default:
      return "Continue";
  }
}

/** Bearing of the route around vertex i: forward (dir 1) or arriving (dir -1), over a short window. */
function bearingAround(c: LngLat[], cum: number[], i: number, dir: 1 | -1): number {
  let j = i + dir;
  while (j > 0 && j < c.length - 1 && Math.abs(cum[j] - cum[i]) < BEARING_WINDOW_M) j += dir;
  j = Math.max(0, Math.min(c.length - 1, j));
  return dir === 1 ? bearing(c[i], c[j]) : bearing(c[j], c[i]);
}

/** Degrees clockwise from north. */
export function bearing(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
  const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** -180..180 */
function normalize(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

export function compass(deg: number): string {
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(deg / 45) % 8];
}

export function polylineLength(c: LngLat[]): number {
  let m = 0;
  for (let i = 1; i < c.length; i++) m += distanceMeters(c[i - 1], c[i]);
  return m;
}
