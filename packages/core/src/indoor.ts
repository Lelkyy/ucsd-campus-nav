import { bearing, compass } from "./instructions.ts";
import { distanceMeters } from "./geo.ts";
import type { Route } from "./route.ts";
import type { Building, Entrance, IndoorRoom, LngLat } from "./types.ts";

export interface FloorGuess {
  /** "2", "B", "0" */
  floor: string;
  label: string;
  /** "map": an indoor room mapped in OpenStreetMap; "number": guessed from the room number. */
  source: "map" | "number";
}

/**
 * UCSD room numbers usually start with the floor: WLH 2001 and CENTR 214 are
 * on floor 2, B210 is in the basement. A guess, not a fact, so it's labelled.
 */
export function floorFromRoom(room: string): FloorGuess | null {
  const r = room.trim().toUpperCase();
  if (/^B[-\s]?\d+/.test(r)) return { floor: "B", label: "Basement", source: "number" };
  const digits = r.replace(/^[A-Z](?=\d)/, ""); // "E209" (wing letter) -> "209"
  const m = digits.match(/^(\d)\d{2,3}[A-Z]?$/);
  if (!m) return null;
  const floor = m[1];
  return { floor, label: floor === "0" ? "Ground level" : `Floor ${floor}`, source: "number" };
}

function levelLabel(level: string): string {
  const n = Number(level.split(";")[0]);
  if (!Number.isFinite(n)) return `Level ${level}`;
  if (n < 0) return "Basement";
  return n === 0 ? "Ground level" : `Floor ${n}`;
}

export interface InsideHints {
  room?: string;
  floor?: FloorGuess;
  /** Mapped position of the room, when OpenStreetMap has it. */
  roomAt?: LngLat;
  /** The door the route ends at. */
  entrance?: Entrance;
  /** "the main entrance on the north side" */
  enterBy?: string;
  elevator: "mapped" | "unknown";
  levels?: number;
}

/** What to do once you reach a building: which door, which floor, elevator. */
export function insideHints(building: Building, room: string | undefined, indoorRooms: IndoorRoom[] | undefined, route: Route | null): InsideHints {
  const hints: InsideHints = { room, elevator: building.elevators ? "mapped" : "unknown", levels: building.levels };
  const mapped = room ? indoorRooms?.find((r) => r.ref.toUpperCase() === room.toUpperCase()) : undefined;
  if (mapped) {
    hints.roomAt = mapped.center;
    if (mapped.level !== undefined) hints.floor = { floor: mapped.level, label: levelLabel(mapped.level), source: "map" };
  }
  if (!hints.floor && room) hints.floor = floorFromRoom(room) ?? undefined;

  const end = route?.legs[route.legs.length - 1];
  const lastNode = end && end.mode !== "bus" ? end.nodes[end.nodes.length - 1] : -1;
  const endAt = route?.coordinates[route.coordinates.length - 1];
  const doors = building.entrances ?? [];
  const door =
    doors.find((d) => d.node >= 0 && d.node === lastNode) ??
    (endAt ? doors.filter((d) => distanceMeters(d.lngLat, endAt) < 15).sort((a, b) => distanceMeters(a.lngLat, endAt) - distanceMeters(b.lngLat, endAt))[0] : undefined);
  if (door) {
    hints.entrance = door;
    hints.enterBy = describeEntrance(building, door);
  } else if (endAt) {
    hints.enterBy = `the nearest door on the ${compass(bearing(building.center, endAt))} side`;
  }
  return hints;
}

export function describeEntrance(building: Building, door: Entrance): string {
  const side = compass(bearing(building.center, door.lngLat));
  const kind =
    door.kind === "main" ? "main entrance" : door.kind === "staircase" ? "stairwell door" : door.kind === "secondary" ? "side entrance" : "entrance";
  const access = door.wheelchair === "yes" ? "wheelchair-accessible " : "";
  const label = door.label ? ` (${door.label})` : "";
  return `the ${access}${kind}${label} on the ${side} side`;
}

/**
 * Where a route into a building should end: doors you can't use as an entrance
 * (emergency exits) are dropped, step-free routes prefer wheelchair-accessible
 * doors, and a mapped room pulls the route to the doors nearest it.
 */
export function entranceTargets(
  building: Building,
  coordOf: (node: number) => LngLat,
  opts: { stepFree?: boolean; roomAt?: LngLat } = {},
): number[] {
  const doors = (building.entrances ?? []).filter((d) => d.node >= 0);
  const blocked = new Set(doors.filter((d) => d.kind === "emergency" || d.kind === "exit").map((d) => d.node));
  let targets = building.targets.filter((t) => !blocked.has(t));
  if (targets.length === 0) targets = building.targets;
  if (opts.stepFree) {
    const accessible = doors.filter((d) => d.wheelchair === "yes" && targets.includes(d.node)).map((d) => d.node);
    if (accessible.length) targets = accessible;
  }
  if (opts.roomAt && targets.length > 1) {
    const roomAt = opts.roomAt;
    const dist = new Map(targets.map((t) => [t, distanceMeters(coordOf(t), roomAt)]));
    const nearest = Math.min(...dist.values());
    targets = targets.filter((t) => dist.get(t)! <= nearest + 25);
  }
  return targets;
}
