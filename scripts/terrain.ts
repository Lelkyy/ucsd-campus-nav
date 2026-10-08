/**
 * Ground elevation from the open Terrain Tiles on AWS (Mapzen "terrarium" PNGs, mostly USGS 3DEP
 * around here; ~4 m per pixel at zoom 15), for timing walks up and down hills.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzlibSync } from "fflate";
import type { LngLat } from "@campus/core";

const TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
/** The most detailed level the tiles have. */
const ZOOM = 15;
const SIZE = 256;

const tileX = (lon: number) => ((lon + 180) / 360) * 2 ** ZOOM;
const tileY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** ZOOM;
};

/** Download (once) every tile over the [south, west, north, east] box into `dir`. */
export async function fetchTerrain(bbox: readonly [number, number, number, number], dir: string, refresh = false): Promise<void> {
  const [s, w, n, e] = bbox;
  mkdirSync(dir, { recursive: true });
  for (let x = Math.floor(tileX(w)); x <= Math.floor(tileX(e)); x++) {
    for (let y = Math.floor(tileY(n)); y <= Math.floor(tileY(s)); y++) {
      const path = join(dir, `${x}_${y}.png`);
      if (!refresh && existsSync(path)) continue;
      const res = await fetch(`${TILES}/${ZOOM}/${x}/${y}.png`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Terrain tile ${ZOOM}/${x}/${y}: HTTP ${res.status}`);
      writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
    }
  }
}

/** Elevation in meters anywhere in the downloaded tiles (bilinear between pixels). */
export class Terrain {
  private tiles = new Map<string, Float32Array>();
  constructor(private dir: string) {}

  at([lon, lat]: LngLat): number {
    // Pixel centres sit at half-pixel offsets.
    const px = tileX(lon) * SIZE - 0.5;
    const py = tileY(lat) * SIZE - 0.5;
    const [x0, y0] = [Math.floor(px), Math.floor(py)];
    const [fx, fy] = [px - x0, py - y0];
    const z = (x: number, y: number) => this.pixel(x, y);
    return (z(x0, y0) * (1 - fx) + z(x0 + 1, y0) * fx) * (1 - fy) + (z(x0, y0 + 1) * (1 - fx) + z(x0 + 1, y0 + 1) * fx) * fy;
  }

  private pixel(x: number, y: number): number {
    const [tx, ty] = [Math.floor(x / SIZE), Math.floor(y / SIZE)];
    const key = `${tx}_${ty}`;
    let tile = this.tiles.get(key);
    if (!tile) {
      const path = join(this.dir, `${key}.png`);
      if (!existsSync(path)) throw new Error(`No terrain tile ${key}; run with --refresh`);
      tile = decodeTerrarium(readFileSync(path));
      this.tiles.set(key, tile);
    }
    return tile[(y - ty * SIZE) * SIZE + (x - tx * SIZE)];
  }
}

/** A terrarium PNG (8-bit RGB or RGBA) to elevations: red * 256 + green + blue / 256 - 32768. */
function decodeTerrarium(png: Uint8Array): Float32Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 3;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("Unsupported terrain PNG (not 8-bit, or interlaced)");
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!channels) throw new Error("Unsupported terrain PNG color type");
    } else if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  idat.reduce((off, d) => (joined.set(d, off), off + d.length), 0);
  const raw = unzlibSync(joined);
  // Undo the per-row filters.
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = up[i];
      const c = i >= channels ? up[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 255;
    }
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const o = i * channels;
    out[i] = px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
  }
  return out;
}
