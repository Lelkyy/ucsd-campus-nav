/**
 * UC San Diego's surveyed ground plan — the sidewalks, walking paths, bike paths and streets
 * drawn on the official Campus Map — read off its public vector tiles and turned into a raster,
 * to find the paths OpenStreetMap is missing, the bike paths it tags as footpaths, and which
 * roads really have a sidewalk.
 */
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { haversine, type LngLat } from "@campus/core";

const TILES = "https://tiles.arcgis.com/tiles/mXNwDpiENQiMIzRv/arcgis/rest/services/CampusMapVectorApril2/VectorTileServer/tile";
/** The most detailed level the tiles carry (overzoomed above it). */
const ZOOM = 16;

/** Campus Map "Ground Level Basemap" classes (its `_symbol` values) with a role here. */
export const GroundClass = {
  BikePath: 2,
  Building: 3,
  Parking: 15,
  Sidewalk: 20,
  Street: 22,
  WalkingPath: 25,
  ServiceRoad: 29,
} as const;
/**
 * Open ground you can walk across off the paths: lawns, playing fields, dirt, gravel, mulch,
 * sand, curbs, piers (plazas are walking path already). Not: buildings, walls, planters, pools,
 * rock, sheds, sports courts and tracks (often fenced), parking lots or streets.
 */
const OPEN_GROUND = new Set([1, 4, 8, 9, 10, 11, 18, 21, 28]);
// Every class is kept: all of them mark the spot as surveyed.
const KEEP = { has: (symbol: number) => Number.isFinite(symbol) };

export interface GroundShape {
  symbol: number;
  /** Polygon rings (outer and holes, filled even-odd). */
  rings: LngLat[][];
}

/** Every kept shape in the [south, west, north, east] box, tile by tile. */
export async function fetchGround(bbox: readonly [number, number, number, number]): Promise<GroundShape[]> {
  const [s, w, n, e] = bbox;
  const tileX = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** ZOOM);
  const tileY = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** ZOOM);
  };
  const shapes: GroundShape[] = [];
  const round = (x: number) => Math.round(x * 1e7) / 1e7;
  for (let x = tileX(w); x <= tileX(e); x++) {
    for (let y = tileY(n); y <= tileY(s); y++) {
      const res = await fetch(`${TILES}/${ZOOM}/${y}/${x}.pbf`, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`Campus Map tile ${ZOOM}/${y}/${x}: HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length) continue;
      const layer = new VectorTile(new PbfReader(buf)).layers["Ground Level Basemap"];
      for (let i = 0; layer && i < layer.length; i++) {
        const f = layer.feature(i);
        const symbol = Number(f.properties._symbol);
        if (!KEEP.has(symbol)) continue;
        const g = f.toGeoJSON(x, y, ZOOM).geometry;
        const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
        for (const rings of polys)
          shapes.push({ symbol, rings: rings.map((r) => r.map(([lon, lat]) => [round(lon), round(lat)] as LngLat)) });
      }
    }
  }
  return shapes;
}

/** Raster cell bits. */
export const Cell = {
  Walk: 1, // walking path
  Sidewalk: 2,
  Bike: 4, // bike path
  Street: 8, // street or service road
  Known: 16, // anything surveyed (incl. buildings and parking): the map covers this spot
  Covered: 32, // near a path already in the graph
  Alongside: 64, // within a path-width or two of one: a trace here all the way is that path, misaligned
  Open: 128, // open ground to cut across (see OPEN_GROUND)
  Parking: 256, // parking lot: walk anywhere on it
} as const;

/** Ground you can walk on off the paths: open ground, and anywhere in a parking lot. */
export const OFF_PATH = Cell.Open | Cell.Parking;

const CLASS_BITS: Record<number, number> = {
  [GroundClass.WalkingPath]: Cell.Walk,
  [GroundClass.Sidewalk]: Cell.Sidewalk,
  [GroundClass.BikePath]: Cell.Bike,
  [GroundClass.Street]: Cell.Street,
  [GroundClass.ServiceRoad]: Cell.Street,
  [GroundClass.Building]: 0,
  [GroundClass.Parking]: Cell.Parking,
};

/** A metre grid over the box (flat-earth projection; fine at campus scale). */
export class GroundGrid {
  readonly w: number;
  readonly h: number;
  readonly bits: Uint16Array;
  private readonly mx: number;
  private readonly my: number;
  private readonly west: number;
  private readonly north: number;

  constructor(
    bbox: readonly [number, number, number, number],
    readonly cell = 0.5,
  ) {
    const [s, w, n, e] = bbox;
    this.west = w;
    this.north = n;
    this.my = haversine(w, s, w, n) / (n - s);
    this.mx = haversine(w, (s + n) / 2, e, (s + n) / 2) / (e - w);
    this.w = Math.ceil(((e - w) * this.mx) / cell);
    this.h = Math.ceil(((n - s) * this.my) / cell);
    this.bits = new Uint16Array(this.w * this.h);
  }

  /** Fractional cell coordinates of a point. */
  toCell([lon, lat]: LngLat): [number, number] {
    return [((lon - this.west) * this.mx) / this.cell, ((this.north - lat) * this.my) / this.cell];
  }
  toLngLat(x: number, y: number): LngLat {
    return [this.west + (x * this.cell) / this.mx, this.north - (y * this.cell) / this.my];
  }
  at(x: number, y: number): number {
    x = Math.floor(x);
    y = Math.floor(y);
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.bits[y * this.w + x];
  }
  /** Whether any cell within `meters` of the point has one of `mask`'s bits. */
  near(p: LngLat, meters: number, mask: number): boolean {
    const [cx, cy] = this.toCell(p);
    const r = Math.ceil(meters / this.cell);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r && this.at(cx + dx, cy + dy) & mask) return true;
      }
    }
    return false;
  }

  /** Fill a polygon (even-odd over all its rings) with `bit`, sampling at cell centres. */
  fill(rings: LngLat[][], bit: number) {
    const pts = rings.map((r) => r.map((p) => this.toCell(p)));
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const r of pts) for (const [, y] of r) [y0, y1] = [Math.min(y0, y), Math.max(y1, y)];
    for (let y = Math.max(0, Math.ceil(y0 - 0.5)); y <= Math.min(this.h - 1, Math.floor(y1 - 0.5)); y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (const r of pts) {
        for (let k = 0; k < r.length; k++) {
          const [ax, ay] = r[k];
          const [bx, by] = r[(k + 1) % r.length];
          if (ay <= yc !== by <= yc) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const row = y * this.w;
        for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(this.w - 1, Math.floor(xs[k + 1] - 0.5)); x++)
          this.bits[row + x] |= bit;
      }
    }
  }

  /**
   * Whether the straight line a–b crosses only walkable ground or ground in `allowed` (open
   * ground by default): nothing surveyed in the way (building, wall, planter, water, street...),
   * and no more than `unsurveyedMeters` of ground the plan doesn't cover (seams between shapes).
   */
  openBetween(a: LngLat, b: LngLat, allowed: number = Cell.Open, unsurveyedMeters = 1.5): boolean {
    let unsurveyed = 0;
    for (const v of this.sample(a, b)) {
      if (v & (allowed | Cell.Walk | Cell.Sidewalk | Cell.Bike)) continue;
      if (v & Cell.Known) return false;
      if ((unsurveyed += this.cell) > unsurveyedMeters) return false;
    }
    return true;
  }

  /** Share of the line a–b on ground with one of `mask`'s bits. */
  share(a: LngLat, b: LngLat, mask: number): number {
    const cells = this.sample(a, b);
    return cells.filter((v) => v & mask).length / cells.length;
  }

  /** The cells along the line a–b, one per cell length. */
  private sample(a: LngLat, b: LngLat): number[] {
    const [ax, ay] = this.toCell(a);
    const [bx, by] = this.toCell(b);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    const out: number[] = [];
    for (let k = 0; k <= steps; k++) out.push(this.at(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps));
    return out;
  }

  /** Set `bit` on every cell within `meters` of the segment a–b. */
  stroke(a: LngLat, b: LngLat, meters: number, bit: number) {
    const [ax, ay] = this.toCell(a);
    const [bx, by] = this.toCell(b);
    const r = meters / this.cell;
    const [dx, dy] = [bx - ax, by - ay];
    const len2 = dx * dx + dy * dy || 1;
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - r)); y <= Math.min(this.h - 1, Math.ceil(Math.max(ay, by) + r)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - r)); x <= Math.min(this.w - 1, Math.ceil(Math.max(ax, bx) + r)); x++) {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const [px, py] = [ax + t * dx - x, ay + t * dy - y];
        if (px * px + py * py <= r * r) this.bits[y * this.w + x] |= bit;
      }
    }
  }

  static from(bbox: readonly [number, number, number, number], shapes: GroundShape[]): GroundGrid {
    const grid = new GroundGrid(bbox);
    for (const s of shapes) grid.fill(s.rings, (CLASS_BITS[s.symbol] ?? (OPEN_GROUND.has(s.symbol) ? Cell.Open : 0)) | Cell.Known);
    return grid;
  }
}

/** A traced centreline: its points, and whether each end runs into an existing path. */
export interface Trace {
  line: LngLat[];
  /** Share of the line on bike path (vs. walking path or sidewalk). */
  bikeShare: number;
  /** Each end: true if it stops because it reached a path already in the graph. */
  joins: [boolean, boolean];
}

const N8 = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

/**
 * Centrelines of the walkable ground (walking paths, sidewalks, bike paths) that aren't already
 * near a path in the graph: thin the walkable area to a one-cell skeleton, cut it where it reaches
 * the existing paths, and follow what's left into lines.
 */
export function traceMissing(grid: GroundGrid, opts: { minMeters: number; spurMeters: number; holeM2: number }): Trace[] {
  const { w, h, bits } = grid;
  const WALKABLE = Cell.Walk | Cell.Sidewalk | Cell.Bike;
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i++) if (bits[i] & WALKABLE) fg[i] = 1;
  fillHoles(fg, w, h, Math.round(opts.holeM2 / grid.cell ** 2));
  thin(fg, w, h);

  // Cut the skeleton where it's already covered (2 = cut off).
  for (let i = 0; i < fg.length; i++) if (fg[i] && bits[i] & Cell.Covered) fg[i] = 2;
  const nb = (i: number) => {
    const out: number[] = [];
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of N8) {
      const [nx, ny] = [x + dx, y + dy];
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && fg[ny * w + nx] === 1) out.push(ny * w + nx);
    }
    return out;
  };
  const touchesCut = (i: number) => {
    const x = i % w;
    const y = (i - x) / w;
    return N8.some(([dx, dy]) => fg[(y + dy) * w + x + dx] === 2);
  };

  // Junction clusters: neighbouring cells with 3+ neighbours are one junction.
  const deg = new Uint8Array(w * h);
  const cells: number[] = [];
  for (let i = 0; i < fg.length; i++) if (fg[i] === 1) ((deg[i] = nb(i).length), cells.push(i));
  const junctionOf = new Map<number, number>();
  const junction = (i: number) => junctionOf.get(i) ?? -1;
  const junctions: number[][] = [];
  for (const i of cells) {
    if (deg[i] < 3 || junctionOf.has(i)) continue;
    const id = junctions.push([]) - 1;
    const stack = [i];
    junctionOf.set(i, id);
    while (stack.length) {
      const c = stack.pop()!;
      junctions[id].push(c);
      for (const n of nb(c)) if (deg[n] >= 3 && !junctionOf.has(n)) (junctionOf.set(n, id), stack.push(n));
    }
  }
  const isNode = (i: number) => deg[i] !== 2;

  // Follow chains from every end and junction.
  const used = new Uint8Array(w * h);
  const chains: { cells: number[]; ends: [number, number] }[] = [];
  const follow = (start: number, first: number) => {
    const path = [start, first];
    let [prev, cur] = [start, first];
    while (!isNode(cur) && cur !== start) {
      used[cur] = 1;
      const next = nb(cur).find((n) => n !== prev);
      if (next === undefined || (used[next] && !isNode(next) && next !== start)) break;
      [prev, cur] = [cur, next];
      path.push(cur);
    }
    return path;
  };
  const seenPair = new Set<string>();
  for (const i of cells) {
    if (!isNode(i)) continue;
    for (const n of nb(i)) {
      if (junction(i) !== -1 && junction(n) === junction(i)) continue;
      if (!isNode(n) && used[n]) continue;
      if (isNode(n)) {
        const key = i < n ? `${i}-${n}` : `${n}-${i}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
      }
      const path = follow(i, n);
      chains.push({ cells: path, ends: [path[0], path[path.length - 1]] });
    }
  }
  // Closed loops with no end or junction on them.
  for (const i of cells) {
    if (used[i] || isNode(i)) continue;
    const [n] = nb(i);
    used[i] = 1;
    const path = follow(i, n);
    chains.push({ cells: path, ends: [path[0], path[path.length - 1]] });
  }

  // Lines, with junction ends moved to the junction's middle so chains meet exactly.
  const centre = junctions.map((js) => {
    let [sx, sy] = [0, 0];
    for (const c of js) [sx, sy] = [sx + (c % w), sy + Math.floor(c / w)];
    return grid.toLngLat(sx / js.length + 0.5, sy / js.length + 0.5);
  });
  const point = (c: number) => (junction(c) !== -1 ? centre[junction(c)] : grid.toLngLat((c % w) + 0.5, Math.floor(c / w) + 0.5));
  const lengthOf = (line: LngLat[]) => line.reduce((s, p, k) => (k ? s + haversine(line[k - 1][0], line[k - 1][1], p[0], p[1]) : 0), 0);
  let traces = chains.map(({ cells: cs, ends }) => {
    const line = simplify(cs.filter((c, k) => k === 0 || k === cs.length - 1 || junction(c) === -1).map(point), grid.cell * 1.5);
    const bike = cs.filter((c) => bits[c] & Cell.Bike && !(bits[c] & (Cell.Walk | Cell.Sidewalk))).length;
    return {
      line,
      bikeShare: bike / cs.length,
      joins: [touchesCut(ends[0]), touchesCut(ends[1])] as [boolean, boolean],
      free: [deg[ends[0]] <= 1, deg[ends[1]] <= 1],
      meters: lengthOf(line),
    };
  });
  // Spurs: short dead ends that thinning grows into the corners of wide areas.
  traces = traces.filter((t) => {
    const deadEnd = (t.free[0] && !t.joins[0]) || (t.free[1] && !t.joins[1]);
    return deadEnd ? t.meters >= opts.spurMeters : t.meters >= grid.cell * 2;
  });
  return traces
    .filter((t) => t.meters >= opts.minMeters || t.joins[0] || t.joins[1] || !t.free[0] || !t.free[1])
    .map(({ line, bikeShare, joins }) => ({ line, bikeShare, joins }));
}

/** Fill background pockets smaller than `maxCells` (planters, poles, tile seams). Floods are
 *  cut short once they're too big, and big areas are remembered, so this stays linear. */
function fillHoles(fg: Uint8Array, w: number, h: number, maxCells: number) {
  const seen = new Uint8Array(w * h); // 1 = small pocket, 2 = big area, 3 = in the current flood
  const region: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < fg.length; s++) {
    if (fg[s] || seen[s]) continue;
    region.length = stack.length = 0;
    let big = false;
    const visit = (i: number) => {
      seen[i] = 3;
      region.push(i);
      stack.push(i);
    };
    visit(s);
    while (stack.length && !big) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) big = true;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (n === -1 || fg[n] || seen[n] === 3) continue;
        if (seen[n] === 2) big = true;
        else visit(n);
      }
      if (region.length > maxCells) big = true;
    }
    for (const i of region) {
      seen[i] = big ? 2 : 1;
      if (!big) fg[i] = 1;
    }
  }
}

/** Zhang–Suen thinning to an 8-connected one-cell skeleton, working only on the shrinking border. */
function thin(fg: Uint8Array, w: number, h: number) {
  const px = (i: number, k: number) => {
    const x = i % w;
    const y = (i - x) / w;
    const [dx, dy] = N8[k];
    const [nx, ny] = [x + dx, y + dy];
    return nx >= 0 && ny >= 0 && nx < w && ny < h ? fg[ny * w + nx] : 0;
  };
  const border = (i: number) => {
    for (let k = 0; k < 8; k += 2) if (!px(i, k)) return true;
    return false;
  };
  let todo: number[] = [];
  for (let i = 0; i < fg.length; i++) if (fg[i] && border(i)) todo.push(i);
  const queued = new Uint8Array(w * h);
  for (let changed = true; changed;) {
    changed = false;
    for (const step of [0, 1]) {
      const del: number[] = [];
      for (const i of todo) {
        if (!fg[i]) continue;
        // P2..P9 clockwise from north: N8 indices 0..7.
        const p = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => px(i, k));
        const b = p.reduce((s, v) => s + v, 0);
        if (b < 2 || b > 6) continue;
        let a = 0;
        for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) a++;
        if (a !== 1) continue;
        const [n, , e, , s, , wst] = p;
        if (step === 0 ? n * e * s || e * s * wst : n * e * wst || n * s * wst) continue;
        del.push(i);
      }
      if (!del.length) continue;
      changed = true;
      for (const i of del) fg[i] = 0;
      const next: number[] = [];
      const push = (i: number) => {
        if (fg[i] && !queued[i]) ((queued[i] = 1), next.push(i));
      };
      for (const i of todo) push(i);
      for (const i of del) {
        const x = i % w;
        const y = (i - x) / w;
        for (const [dx, dy] of N8) {
          const [nx, ny] = [x + dx, y + dy];
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) push(ny * w + nx);
        }
      }
      for (const i of next) queued[i] = 0;
      todo = next;
    }
  }
  // Staircase corners left by Zhang–Suen: drop cells whose neighbours stay connected without them.
  for (let i = 0; i < fg.length; i++) {
    if (!fg[i]) continue;
    const p = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => px(i, k));
    if (p.reduce((s, v) => s + v, 0) < 2) continue;
    // 8-connected groups among the neighbours (diagonals join through an orthogonal neighbour).
    let groups = 0;
    for (let k = 0; k < 8; k++) {
      if (!p[k]) continue;
      const prevOn = k % 2 === 0 ? p[(k + 7) % 8] || p[(k + 6) % 8] : p[(k + 7) % 8];
      if (!prevOn) groups++;
    }
    if (groups === 0) groups = 1; // all eight set
    if (groups === 1) fg[i] = 0;
  }
}

/** Douglas–Peucker in cell units converted to degrees on the fly (tolerance in metres). */
function simplify(line: LngLat[], meters: number): LngLat[] {
  if (line.length < 3) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const kx = haversine(line[0][0], line[0][1], line[0][0] + 1e-4, line[0][1]) / 1e-4;
  const ky = haversine(line[0][0], line[0][1], line[0][0], line[0][1] + 1e-4) / 1e-4;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = [line[a][0] * kx, line[a][1] * ky];
    const [dx, dy] = [line[b][0] * kx - ax, line[b][1] * ky - ay];
    const len = Math.hypot(dx, dy);
    let [far, farD] = [-1, meters];
    for (let k = a + 1; k < b; k++) {
      const [px, py] = [line[k][0] * kx - ax, line[k][1] * ky - ay];
      const d = len ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
      if (d > farD) [far, farD] = [k, d];
    }
    if (far !== -1) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return line.filter((_, k) => keep[k]);
}
