import { MinHeap } from "./heap.ts";
import { findRoom, levelsOf } from "./indoor.ts";
import type { IndoorRoom, LngLat } from "./types.ts";

/** One floor's part of a walk inside a building. */
export interface IndoorLeg {
  level: number;
  points: LngLat[];
  meters: number;
  /** How you got onto this floor; missing on the floor you came in on. */
  via?: "stairs" | "elevator";
}

export interface IndoorRoute {
  /** Floor by floor, in walking order. */
  legs: IndoorLeg[];
  meters: number;
  room: IndoorRoom;
}

export interface IndoorRouteOptions {
  /** Where you come in: the door the outdoor route ends at, or where it reaches the building. */
  from: LngLat;
  /** The floor that door opens onto (OSM level, ground = 0). */
  fromLevel?: number;
  /** Elevators only, no stairs. */
  stepFree?: boolean;
}

/** Grid cell size in meters. */
const CELL = 0.5;
/** The door can be at most this far from mapped walkable space. */
const MAX_DOOR_GAP_M = 6;
/** Extra cost, in meters of walking, of changing floor by stairs (per floor) and of taking an elevator. */
const STAIRS_COST_M = 10;
const ELEVATOR_COST_M = 25;
/** Keep the grid small enough to search instantly. */
const MAX_CELLS_PER_LEVEL = 200_000;

/**
 * The way from the door to a room, through the building's mapped corridors,
 * lobbies and open areas (A* on a fine grid over each floor plan), changing
 * floor in mapped stairwells or elevators.
 *
 * Returns null when the building isn't mapped well enough to say: the room
 * has no outline, the door doesn't open onto mapped space, or no chain of
 * mapped corridors and stairs connects them. Other rooms are never walked
 * through, and nothing is guessed.
 */
export function indoorRoute(rooms: IndoorRoom[] | undefined, roomRef: string, opts: IndoorRouteOptions): IndoorRoute | null {
  const target = findRoom(rooms, roomRef);
  if (!target || target.source !== "osm" || !target.outline) return null;
  const targetLevel = levelsOf(target.level)[0];
  if (targetLevel === undefined) return null;

  const spaces = (rooms ?? []).filter((r) => r.source === "osm" && (r.outline || r.line) && levelsOf(r.level).length > 0);
  const walkable = spaces.filter((r) => r === target || r.kind !== "room" || r.use !== undefined);
  // A floor whose corridors aren't mapped can't be routed on, even if the stairs reach it.
  const isHallway = (r: IndoorRoom) => (r.kind === "room" ? r.use === "lobby" : r.use !== "stairs" && r.use !== "elevator");
  if (!spaces.some((r) => isHallway(r) && levelsOf(r.level).includes(targetLevel))) return null;
  const connectors = spaces.filter((r) => r.outline && (r.use === "elevator" || (r.use === "stairs" && !opts.stepFree)) && levelsOf(r.level).length > 1);

  // Local flat projection in meters (x east, y north) over everything involved.
  const all = [...walkable.flatMap((r) => r.outline ?? r.line ?? []), opts.from];
  const lon0 = Math.min(...all.map((p) => p[0]));
  const lat0 = Math.min(...all.map((p) => p[1]));
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110_574;
  const toXY = ([lon, lat]: LngLat): [number, number] => [(lon - lon0) * mx + 2, (lat - lat0) * my + 2];
  const widthM = Math.max(...all.map((p) => toXY(p)[0])) + 2;
  const heightM = Math.max(...all.map((p) => toXY(p)[1])) + 2;
  const cell = Math.max(CELL, Math.sqrt((widthM * heightM) / MAX_CELLS_PER_LEVEL));
  const cols = Math.ceil(widthM / cell);
  const rows = Math.ceil(heightM / cell);
  const N = cols * rows;
  const centerOf = (c: number): [number, number] => [((c % cols) + 0.5) * cell, (Math.floor(c / cols) + 0.5) * cell];
  const toLngLat = ([x, y]: [number, number]): LngLat => [lon0 + (x - 2) / mx, lat0 + (y - 2) / my];

  /** Cells whose centers fall inside a polygon (or within `buffer` m of a line). */
  const cellsOf = (r: IndoorRoom, buffer = 1): number[] => {
    const out: number[] = [];
    if (r.outline) {
      const ring = r.outline.map(toXY);
      const [x0, x1, y0, y1] = bounds(ring);
      for (let row = Math.max(0, Math.floor(y0 / cell)); row <= Math.min(rows - 1, Math.floor(y1 / cell)); row++) {
        for (let col = Math.max(0, Math.floor(x0 / cell)); col <= Math.min(cols - 1, Math.floor(x1 / cell)); col++) {
          if (inRing([(col + 0.5) * cell, (row + 0.5) * cell], ring)) out.push(row * cols + col);
        }
      }
      // A space smaller than a cell still gets its middle.
      if (!out.length) out.push(cellAt(toXY(r.center)));
    } else if (r.line) {
      const line = r.line.map(toXY);
      const [x0, x1, y0, y1] = bounds(line);
      for (let row = Math.max(0, Math.floor((y0 - buffer) / cell)); row <= Math.min(rows - 1, Math.floor((y1 + buffer) / cell)); row++) {
        for (let col = Math.max(0, Math.floor((x0 - buffer) / cell)); col <= Math.min(cols - 1, Math.floor((x1 + buffer) / cell)); col++) {
          if (distToLine([(col + 0.5) * cell, (row + 0.5) * cell], line) <= buffer) out.push(row * cols + col);
        }
      }
    }
    return out;
  };
  const cellAt = ([x, y]: [number, number]): number =>
    Math.min(rows - 1, Math.max(0, Math.floor(y / cell))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(x / cell)));

  // Walkable cells per floor. Neighbouring spaces share walls, so each space is
  // grown by one cell to close the hairline gaps mapping leaves between them.
  const levels = [...new Set([...walkable.flatMap((r) => levelsOf(r.level)), targetLevel])].sort((a, b) => a - b);
  const li = new Map(levels.map((l, i) => [l, i]));
  const masks = levels.map(() => new Uint8Array(N));
  const roomCells = new Set(cellsOf(target));
  for (const r of walkable) {
    const cells = r === target ? [...roomCells] : cellsOf(r);
    for (const l of levelsOf(r.level)) {
      const mask = masks[li.get(l)!];
      for (const c of cells) {
        mask[c] = 1;
        if (r === target) continue; // Don't grow the room into its neighbours.
        const col = c % cols;
        if (col > 0) mask[c - 1] = 1;
        if (col < cols - 1) mask[c + 1] = 1;
        if (c >= cols) mask[c - cols] = 1;
        if (c + cols < N) mask[c + cols] = 1;
      }
    }
  }
  // Floor changes: inside a stairwell or elevator, each floor it serves connects to the next.
  const vertical = new Map<number, { to: number; cost: number; via: "stairs" | "elevator" }[]>();
  for (const r of connectors) {
    const ls = levelsOf(r.level).filter((l) => li.has(l)).sort((a, b) => a - b);
    const via = r.use as "stairs" | "elevator";
    const cells = cellsOf(r);
    for (let k = 0; k + 1 < ls.length; k++) {
      const [a, b] = [li.get(ls[k])!, li.get(ls[k + 1])!];
      const cost = via === "elevator" ? ELEVATOR_COST_M / 2 : STAIRS_COST_M;
      for (const c of cells) {
        if (!masks[a][c] || !masks[b][c]) continue;
        push(vertical, a * N + c, { to: b * N + c, cost, via });
        push(vertical, b * N + c, { to: a * N + c, cost, via });
      }
    }
  }

  // Start: the walkable cell nearest the door, on the floor it opens onto.
  const fromXY = toXY(opts.from);
  const startLevels = opts.fromLevel !== undefined && li.has(opts.fromLevel) ? [opts.fromLevel] : li.has(0) ? [0] : [];
  let start = -1;
  let startGap = Infinity;
  for (const l of startLevels) {
    const mask = masks[li.get(l)!];
    for (let c = 0; c < N; c++) {
      if (!mask[c]) continue;
      const [x, y] = centerOf(c);
      const d = Math.hypot(x - fromXY[0], y - fromXY[1]);
      if (d < startGap) [start, startGap] = [li.get(l)! * N + c, d];
    }
  }
  if (start < 0 || startGap > MAX_DOOR_GAP_M) return null;

  // A* over (floor, cell).
  const goalLevel = li.get(targetLevel)!;
  const goal = (n: number) => Math.floor(n / N) === goalLevel && roomCells.has(n % N);
  // Straight-line distance to the room's bounding box never overestimates.
  const [rx0, rx1, ry0, ry1] = bounds(target.outline.map(toXY));
  const h = (n: number) => {
    const [x, y] = centerOf(n % N);
    return Math.hypot(Math.max(rx0 - x, 0, x - rx1), Math.max(ry0 - y, 0, y - ry1));
  };
  const g = new Float64Array(levels.length * N).fill(Infinity);
  const parent = new Int32Array(levels.length * N).fill(-1);
  const done = new Uint8Array(levels.length * N);
  const open = new MinHeap();
  g[start] = 0;
  open.push(start, h(start));
  let end = -1;
  const DIRS: [number, number, number][] = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  while (open.size) {
    const n = open.pop();
    if (done[n]) continue;
    done[n] = 1;
    if (goal(n)) {
      end = n;
      break;
    }
    const lvl = Math.floor(n / N);
    const c = n % N;
    const mask = masks[lvl];
    const col = c % cols;
    const row = Math.floor(c / cols);
    const relax = (m: number, cost: number) => {
      const ng = g[n] + cost;
      if (ng < g[m]) {
        g[m] = ng;
        parent[m] = n;
        open.push(m, ng + h(m));
      }
    };
    for (const [dx, dy, len] of DIRS) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const m = nr * cols + nc;
      if (!mask[m]) continue;
      // No cutting corners through walls.
      if (dx && dy && (!mask[row * cols + nc] || !mask[nr * cols + col])) continue;
      relax(lvl * N + m, len * cell);
    }
    for (const v of vertical.get(n) ?? []) relax(v.to, v.cost);
  }
  if (end < 0) return null;

  // Unwind into floors, then straighten each floor's part where the way is clear.
  const chain: number[] = [];
  for (let n = end; n >= 0; n = parent[n]) chain.push(n);
  chain.reverse();
  const legs: IndoorLeg[] = [];
  let run: number[] = [];
  const flush = (via?: "stairs" | "elevator") => {
    const lvl = Math.floor(run[0] / N);
    const pts = straighten(run.map((n) => n % N), masks[lvl], cols, centerOf);
    if (!legs.length) pts.unshift(fromXY);
    const meters = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
    legs.push({ level: levels[lvl], points: pts.map(toLngLat), meters, ...(via ? { via } : {}) });
  };
  let via: "stairs" | "elevator" | undefined;
  for (let i = 0; i < chain.length; i++) {
    if (i > 0 && Math.floor(chain[i] / N) !== Math.floor(chain[i - 1] / N)) {
      flush(via);
      via = vertical.get(chain[i - 1])!.find((v) => v.to === chain[i])!.via;
      run = [];
    }
    run.push(chain[i]);
  }
  flush(via);
  // A run that only stepped across a stairwell's floors in place has one point; drop it.
  const kept = legs.filter((l, i) => i === 0 || i === legs.length - 1 || l.points.length > 1);
  return { legs: kept, meters: kept.reduce((s, l) => s + l.meters, 0), room: target };
}

/** Greedy line-of-sight smoothing of a grid path (on one floor). */
function straighten(cells: number[], mask: Uint8Array, cols: number, centerOf: (c: number) => [number, number]): [number, number][] {
  const out = [centerOf(cells[0])];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1 && !clear(cells[i], cells[j], mask, cols)) j--;
    out.push(centerOf(cells[j]));
    i = j;
  }
  return out;
}

/** Whether every cell on the straight line between two cells is walkable. */
function clear(a: number, b: number, mask: Uint8Array, cols: number): boolean {
  const [ax, ay] = [a % cols, Math.floor(a / cols)];
  const [bx, by] = [b % cols, Math.floor(b / cols)];
  const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2;
  for (let s = 1; s < steps; s++) {
    const x = ax + ((bx - ax) * s) / steps;
    const y = ay + ((by - ay) * s) / steps;
    // Check the cells the line touches, not just the nearest one, so it can't slip through a wall corner.
    for (const cx of [Math.floor(x + 0.25), Math.ceil(x - 0.25)]) {
      for (const cy of [Math.floor(y + 0.25), Math.ceil(y - 0.25)]) {
        if (!mask[cy * cols + cx]) return false;
      }
    }
  }
  return true;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function bounds(pts: [number, number][]): [number, number, number, number] {
  return [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
}

function inRing([x, y]: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToLine([x, y]: [number, number], line: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

/** Where you'd be a fraction `t` (0–1) of the way along an indoor route: floor and spot. */
export function indoorPositionAt(route: IndoorRoute, t: number): { level: number; at: LngLat; leg: number } {
  let left = Math.max(0, Math.min(1, t)) * route.meters;
  for (let k = 0; k < route.legs.length; k++) {
    const { points, level } = route.legs[k];
    for (let i = 0; i + 1 < points.length; i++) {
      const [a, b] = [points[i], points[i + 1]];
      const len = Math.hypot((b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * 110_574);
      if (left <= len) {
        const f = len ? left / len : 0;
        return { level, at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], leg: k };
      }
      left -= len;
    }
  }
  const last = route.legs[route.legs.length - 1];
  return { level: last.level, at: last.points[last.points.length - 1], leg: route.legs.length - 1 };
}
