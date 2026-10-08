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
  /** Where the room is pinned on the map: the centre of its building. */
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
  if (mapped) hints.mappedRoom = mapped;
  // Every room is pinned to the middle of its building.
  if (room) hints.roomAt = buildingCentre(building);
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
 * (emergency exits) are dropped, and step-free routes prefer wheelchair-accessible doors.
 */
export function entranceTargets(building: Building, opts: { stepFree?: boolean } = {}): number[] {
  const doors = (building.entrances ?? []).filter((d) => d.node >= 0);
  const blocked = new Set(doors.filter((d) => d.kind === "emergency" || d.kind === "exit").map((d) => d.node));
  let targets = building.targets.filter((t) => !blocked.has(t));
  if (targets.length === 0) targets = building.targets;
  if (opts.stepFree) {
    const accessible = doors.filter((d) => d.wheelchair === "yes" && targets.includes(d.node)).map((d) => d.node);
    if (accessible.length) targets = accessible;
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

/**
 * The middle of a building, always inside it: the point of its largest outline farthest from
 * every wall (for an L or a U, in the thickest part, never in the gap the shape wraps round),
 * nudged toward its centre of mass where that's a near tie (so a long rectangle's pin is in its
 * middle, not at one end). Found on a grid over the outline, then refined around the best.
 */
export function buildingCentre(building: Building): LngLat {
  const ring = (building.outline ?? []).reduce<LngLat[]>((big, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(big)) ? r : big), []);
  if (ring.length < 4) return building.center;
  const a = ringArea(ring);
  let [mx, my] = [0, 0];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    mx += (ring[j][0] + ring[i][0]) * f;
    my += (ring[j][1] + ring[i][1]) * f;
  }
  const mass: LngLat = a ? [mx / (6 * a), my / (6 * a)] : building.center;
  // Meters from the nearest wall, less a little for being away from the centre of mass.
  const depth = (p: LngLat) => {
    if (!inRing(p, ring)) return -Infinity;
    let d = Infinity;
    for (let i = 1; i < ring.length; i++) d = Math.min(d, distanceToSegment(p, ring[i - 1], ring[i]));
    return d - 0.05 * distanceMeters(p, mass);
  };
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) [w, s, e, n] = [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)];
  let best: LngLat = building.center;
  let bestD = depth(best);
  let [cx, cy, hx, hy] = [(w + e) / 2, (s + n) / 2, (e - w) / 2, (n - s) / 2];
  for (let round = 0; round < 4; round++) {
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const p: LngLat = [cx - hx + (2 * hx * i) / steps, cy - hy + (2 * hy * j) / steps];
        const d = depth(p);
        if (d > bestD) [best, bestD] = [p, d];
      }
    }
    // Zoom in around the best so far.
    [cx, cy, hx, hy] = [best[0], best[1], hx / 4, hy / 4];
  }
  return best;
}

/**
 * The building you're in, or right beside (within `meters` of its walls; GPS wanders near and
 * inside buildings), or null.
 */
export function buildingAt(buildings: Building[], p: LngLat, meters: number): Building | null {
  let best: Building | null = null;
  let bestD = meters;
  for (const b of buildings) {
    if (!b.outline?.length || distanceMeters(b.center, p) > 400) continue;
    for (const ring of b.outline) {
      if (inRing(p, ring)) return b;
      for (let i = 1; i < ring.length; i++) {
        const d = distanceToSegment(p, ring[i - 1], ring[i]);
        if (d < bestD) [best, bestD] = [b, d];
      }
    }
  }
  return best;
}

/** Signed area of a ring in square degrees (for the centroid only). */
function ringArea(ring: LngLat[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

function inRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Meters from p to the segment a–b (flat at campus scale). */
function distanceToSegment(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110_540;
  const [ax, ay] = [(a[0] - p[0]) * kx, (a[1] - p[1]) * ky];
  const [dx, dy] = [(b[0] - a[0]) * kx, (b[1] - a[1]) * ky];
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
