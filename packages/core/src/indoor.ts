import { bearing, compass } from "./instructions.ts";
import { distanceMeters } from "./geo.ts";
import type { Route } from "./route.ts";
import type { Building, Entrance, IndoorRoom, LngLat } from "./types.ts";

export interface FloorGuess {
  /** "2", "B", "0" */
  floor: string;
  label: string;
  /** "map": mapped in OpenStreetMap; "pinned": marked by a student; "number": guessed from the room number. */
  source: "map" | "pinned" | "number";
}

/**
 * UCSD room numbers usually start with the floor: WLH 2001 and CENTR 214 are
 * on floor 2, B210 is in the basement. A guess, not a fact, so it's labelled.
 */
export function floorFromRoom(room: string): FloorGuess | null {
  const r = room.trim().toUpperCase();
  if (/^B[-\s]?\d+/.test(r)) return { floor: "B", label: "Basement", source: "number" };
  const digits = r.replace(/^[A-Z](?=\d)/, ""); // "E209" (wing letter) -> "209"
  // "2001", "209A", and a wing letter after the floor: "1E106" (Otterson), "2A03" (BRF2).
  const m = digits.match(/^(\d)\d{2,3}[A-Z]?$/) ?? digits.match(/^(\d)[A-Z]\d{2,3}$/);
  if (!m) return null;
  const floor = m[1];
  return { floor, label: floor === "0" ? "Ground level" : floor === "1" ? "Floor 1 (ground)" : `Floor ${floor}`, source: "number" };
}

/**
 * OpenStreetMap counts the ground floor as level 0; US buildings call it floor 1.
 * So level 2 is "Floor 3", and negative levels are basements.
 */
export function levelLabel(level: string | number): string {
  const n = typeof level === "number" ? level : Number(String(level).split(";")[0]);
  if (!Number.isFinite(n)) return `Level ${level}`;
  if (n < 0) return n === -1 ? "Basement" : `Basement ${-n}`;
  return n === 0 ? "Floor 1 (ground)" : `Floor ${n + 1}`;
}

/** Inverse of levelLabel's numbering: a US floor ("B", "1", "3") to an OSM level. */
export function floorToLevel(floor: string): number {
  if (/^B\d*$/i.test(floor)) return -Math.max(1, Number(floor.slice(1)) || 1);
  return Math.max(0, Number(floor) - 1);
}

/** Which floor a room is on: from the floor plan or a student's pin, else its number. */
export function roomFloor(indoorRooms: IndoorRoom[] | undefined, room: string): FloorGuess | undefined {
  const mapped = findRoom(indoorRooms, room);
  if (mapped?.level !== undefined) {
    return { floor: mapped.level, label: levelLabel(mapped.level), source: mapped.source === "pinned" ? "pinned" : "map" };
  }
  return floorFromRoom(room) ?? undefined;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** A rough pointer to a floor, US style: "on the first floor", "in the basement". */
export function floorPhrase(floor: FloorGuess): string {
  // Guesses from room numbers are US floors ("2", "B"); mapped ones are OSM levels (ground = 0).
  const level = floor.source === "number" ? floorToLevel(floor.floor) : Number(floor.floor.split(";")[0]);
  if (!Number.isFinite(level)) return `on ${floor.label.toLowerCase()}`;
  if (level < 0) return level === -1 ? "in the basement" : `on basement level ${-level}`;
  return `on the ${ORDINALS[level] ?? `${level + 1}th`} floor`;
}

export interface InsideHints {
  room?: string;
  floor?: FloorGuess;
  /** Mapped position of the room, when OpenStreetMap (or a student pin) has it. */
  roomAt?: LngLat;
  mappedRoom?: IndoorRoom;
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
  const mapped = room ? findRoom(indoorRooms, room) : undefined;
  if (mapped) {
    hints.roomAt = mapped.center;
    hints.mappedRoom = mapped;
  }
  if (room) hints.floor = roomFloor(indoorRooms, room);

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

/** A numbered room in a building's indoor data (pins override the map). */
export function findRoom(rooms: IndoorRoom[] | undefined, room: string): IndoorRoom | undefined {
  const want = room.trim().toUpperCase();
  const matches = (rooms ?? []).filter((r) => r.kind === "room" && r.ref?.toUpperCase() === want);
  return matches.find((r) => r.source === "pinned") ?? matches[0];
}

/** Levels a feature is on: "2" -> [2], "0-3" -> [0,1,2,3], "-1;0;1" -> [-1,0,1]. */
export function levelsOf(level: string | undefined): number[] {
  if (level === undefined) return [];
  return level.split(";").flatMap((part) => {
    const m = part.trim().match(/^(-?\d+)\s*-\s*(-?\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => Math.min(a, b) + i);
    }
    const n = Number(part);
    return Number.isFinite(n) ? [n] : [];
  });
}
