import { describe, expect, it } from "vitest";
import { indoorPositionAt, indoorRoute } from "./indoorRoute.ts";
import type { IndoorRoom, LngLat } from "./types.ts";

// A small two-storey building, laid out in meters east/north of a corner.
const LON0 = -117.233;
const LAT0 = 32.881;
const MX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const MY = 110_574;
const at = (x: number, y: number): LngLat => [LON0 + x / MX, LAT0 + y / MY];
const box = (x0: number, y0: number, x1: number, y1: number): LngLat[] => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
const space = (kind: IndoorRoom["kind"], level: string, [x0, y0, x1, y1]: number[], extra: Partial<IndoorRoom> = {}): IndoorRoom => ({
  kind,
  level,
  outline: box(x0, y0, x1, y1),
  center: at((x0 + x1) / 2, (y0 + y1) / 2),
  source: "osm",
  ...extra,
});

const ROOMS: IndoorRoom[] = [
  space("corridor", "0", [0, 0, 30, 3]),
  space("corridor", "1", [0, 0, 30, 3]),
  space("room", "0", [10, 3, 15, 8], { ref: "101" }),
  space("room", "0", [40, 3, 45, 8], { ref: "102" }), // off on its own: no corridor reaches it
  space("room", "1", [20, 3, 25, 8], { ref: "201" }),
  space("room", "0;1;2", [0, 3, 3, 6], { use: "stairs" }),
  space("room", "0;1", [26, 3, 29, 6], { use: "elevator" }),
  space("room", "2", [3, 3, 6, 6], { ref: "301" }), // floor 3 has no mapped corridors
  space("room", "1", [10, 3, 15, 8], { ref: "203", source: "pinned" }),
];
const DOOR = { from: at(-1, 1.5), fromLevel: 0 };

describe("indoorRoute", () => {
  it("walks the corridor to a room on the same floor", () => {
    const r = indoorRoute(ROOMS, "101", DOOR)!;
    expect(r).not.toBeNull();
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0].level).toBe(0);
    // About 13 m along the corridor, then into the room.
    expect(r.meters).toBeGreaterThan(11);
    expect(r.meters).toBeLessThan(18);
  });

  it("takes the nearest stairs up, then walks to the room", () => {
    const r = indoorRoute(ROOMS, "201", DOOR)!;
    expect(r.legs.map((l) => l.level)).toEqual([0, 1]);
    expect(r.legs[1].via).toBe("stairs");
  });

  it("uses the elevator when avoiding stairs", () => {
    const r = indoorRoute(ROOMS, "201", { ...DOOR, stepFree: true })!;
    expect(r.legs.map((l) => l.level)).toEqual([0, 1]);
    expect(r.legs[1].via).toBe("elevator");
  });

  it("stays in corridors instead of cutting through other rooms", () => {
    const r = indoorRoute(ROOMS, "201", DOOR)!;
    // On floor 2 the way runs along the corridor (y < 3) until it turns into 201.
    const pts = r.legs[1].points.slice(0, -1).map(([lon, lat]) => [(lon - LON0) * MX, (lat - LAT0) * MY]);
    expect(pts.every(([x, y]) => y < 3.6 || (x > 19.5 && x < 25.5))).toBe(true);
  });

  it("gives up when the space isn't mapped well enough to route", () => {
    expect(indoorRoute(ROOMS, "102", DOOR)).toBeNull(); // no corridor to it
    expect(indoorRoute(ROOMS, "301", DOOR)).toBeNull(); // its floor's corridors aren't mapped
    expect(indoorRoute(ROOMS, "203", DOOR)).toBeNull(); // only a pin, no floor plan
    expect(indoorRoute(ROOMS, "999", DOOR)).toBeNull();
    expect(indoorRoute(ROOMS, "101", { from: at(-30, 1.5) })).toBeNull(); // door far from any mapped space
  });

  it("animates along the route, floor by floor", () => {
    const r = indoorRoute(ROOMS, "201", DOOR)!;
    expect(indoorPositionAt(r, 0)).toMatchObject({ level: 0, leg: 0 });
    expect(indoorPositionAt(r, 0).at).toEqual(r.legs[0].points[0]);
    expect(indoorPositionAt(r, 1)).toMatchObject({ level: 1, leg: 1 });
  });
});
