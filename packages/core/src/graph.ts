import { haversine } from "./geo.ts";
import type { EdgeKind, GraphData, LngLat } from "./types.ts";

/** Grid cell size in degrees (~50 m at UCSD's latitude). */
const CELL_DEG = 0.0005;

/**
 * In-memory walking graph: adjacency in CSR form plus a coarse grid index
 * for snapping arbitrary points to the nearest node.
 */
export class CampusGraph {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly lon: Float64Array;
  readonly lat: Float64Array;
  /** Walking-network component per node, and the main (central campus) one. */
  readonly component: Int32Array;
  readonly mainComponent: number;
  /** Riding-network component per node (all edges), and the main one. */
  readonly bikeComponent: Int32Array;
  readonly mainBikeComponent: number;

  readonly edgeFrom: Uint32Array;
  readonly edgeTo: Uint32Array;
  readonly edgeKind: Uint8Array;
  readonly edgeLength: Float32Array;

  /** Neighbors of node i are adjEdge[adjStart[i] .. adjStart[i + 1]). */
  readonly adjStart: Uint32Array;
  readonly adjEdge: Uint32Array;

  private readonly grid = new Map<string, number[]>();

  constructor(readonly data: GraphData) {
    const n = data.coords.length / 2;
    const m = data.edges.length / 3;
    this.nodeCount = n;
    this.edgeCount = m;

    this.lon = new Float64Array(n);
    this.lat = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.lon[i] = data.coords[2 * i];
      this.lat[i] = data.coords[2 * i + 1];
    }
    this.component = Int32Array.from(data.components);
    this.mainComponent = data.mainComponent;
    this.bikeComponent = Int32Array.from(data.bikeComponents);
    this.mainBikeComponent = data.mainBikeComponent;

    this.edgeFrom = new Uint32Array(m);
    this.edgeTo = new Uint32Array(m);
    this.edgeKind = new Uint8Array(m);
    this.edgeLength = new Float32Array(m);
    const degree = new Uint32Array(n);
    for (let e = 0; e < m; e++) {
      const a = data.edges[3 * e];
      const b = data.edges[3 * e + 1];
      this.edgeFrom[e] = a;
      this.edgeTo[e] = b;
      this.edgeKind[e] = data.edges[3 * e + 2];
      this.edgeLength[e] = haversine(this.lon[a], this.lat[a], this.lon[b], this.lat[b]);
      degree[a]++;
      degree[b]++;
    }

    this.adjStart = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.adjStart[i + 1] = this.adjStart[i] + degree[i];
    this.adjEdge = new Uint32Array(2 * m);
    const fill = this.adjStart.slice(0, n);
    for (let e = 0; e < m; e++) {
      this.adjEdge[fill[this.edgeFrom[e]]++] = e;
      this.adjEdge[fill[this.edgeTo[e]]++] = e;
    }

    for (let i = 0; i < n; i++) {
      if (degree[i] === 0) continue;
      const key = cellKey(Math.floor(this.lon[i] / CELL_DEG), Math.floor(this.lat[i] / CELL_DEG));
      const cell = this.grid.get(key);
      if (cell) cell.push(i);
      else this.grid.set(key, [i]);
    }
  }

  coord(i: number): LngLat {
    return [this.lon[i], this.lat[i]];
  }

  /** The node at the other end of edge `e` from node `from`. */
  other(e: number, from: number): number {
    return this.edgeFrom[e] === from ? this.edgeTo[e] : this.edgeFrom[e];
  }

  kind(e: number): EdgeKind {
    return this.edgeKind[e] as EdgeKind;
  }

  /** On the main walking network (so a walking route can always be found). */
  onWalkNetwork = (i: number): boolean => this.component[i] === this.mainComponent;
  /** On the main riding network. */
  onBikeNetwork = (i: number): boolean => this.bikeComponent[i] === this.mainBikeComponent;

  /**
   * Nearest node to `p` that passes `accept` (default: on the main walking network).
   * Returns -1 if nothing is within `maxMeters`.
   */
  nearestNode(p: LngLat, opts: { accept?: (i: number) => boolean; maxMeters?: number } = {}): number {
    const { accept = this.onWalkNetwork, maxMeters = 2000 } = opts;
    const cx = Math.floor(p[0] / CELL_DEG);
    const cy = Math.floor(p[1] / CELL_DEG);
    // One cell is at least ~45 m in either direction around here.
    const cellMeters = 45;
    const maxRing = Math.ceil(maxMeters / cellMeters) + 1;

    let best = -1;
    let bestDist = Infinity;
    for (let r = 0; r <= maxRing; r++) {
      for (let x = cx - r; x <= cx + r; x++) {
        for (let y = cy - r; y <= cy + r; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue; // ring only
          const cell = this.grid.get(cellKey(x, y));
          if (!cell) continue;
          for (const i of cell) {
            if (!accept(i)) continue;
            const d = haversine(p[0], p[1], this.lon[i], this.lat[i]);
            if (d < bestDist) {
              bestDist = d;
              best = i;
            }
          }
        }
      }
      // Anything in ring r+1 is at least r * cellMeters away.
      if (best !== -1 && bestDist <= r * cellMeters) break;
    }
    return bestDist <= maxMeters ? best : -1;
  }
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}
