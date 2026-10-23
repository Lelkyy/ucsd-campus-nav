import { describe, expect, it } from "vitest";
import { reachedTimes, snapAlong, stopDistances, tripProgress } from "./arrivals.ts";
import { measurePath } from "./liveTransit.ts";
import type { LngLat } from "./types.ts";

// A straight route 1 km north, and back south along the same street: a loop over its own path.
// 111,195 m a degree of latitude, as the haversine measures it.
const north = (m: number): LngLat => [-117.2, 32.88 + m / 111_195];
const out = measurePath([north(0), north(1000)]);
/** Within 10 m. */
const near = (x: number, y: number) => expect(Math.abs(x - y)).toBeLessThan(10);
const loop = measurePath([north(0), north(1000), north(0)]);

describe("snapAlong", () => {
  it("gives meters along the route and how far off it a point is", () => {
    const s = snapAlong(out, [-117.2 + 20 / 93_400, north(400)[1]]);
    near(s.along, 400);
    near(s.off, 20);
  });
});

describe("stopDistances", () => {
  it("places a loop's stops in order, the way back after the way out", () => {
    const d = stopDistances(loop, [north(300), north(900), north(300)]);
    near(d[0], 300);
    near(d[1], 900);
    near(d[2], 1700);
  });

  it("puts a loop's first stop at its start, though the loop ends there too", () => {
    const d = stopDistances(loop, [north(0), north(500), north(0)]);
    near(d[0], 0);
    near(d[1], 500);
    near(d[2], 2000);
  });
});

describe("tripProgress", () => {
  it("only moves forward and drops readings far off the route", () => {
    const p = tripProgress(out, [
      { t: 0, lngLat: north(100) },
      { t: 30_000, lngLat: north(300) },
      { t: 60_000, lngLat: north(290) }, // jitter behind
      { t: 90_000, lngLat: [-117.19, north(500)[1]] }, // ~900 m off
      { t: 120_000, lngLat: north(600) },
    ]);
    expect(p.map((x) => [x.t, Math.round(x.along / 10) * 10])).toEqual([
      [0, 100],
      [30_000, 300],
      [60_000, 300],
      [120_000, 600],
    ]);
  });
});

describe("reachedTimes", () => {
  const progress = [
    { t: 0, along: 100 },
    { t: 30_000, along: 400 },
    { t: 60_000, along: 400 }, // at the stop
    { t: 300_000, along: 900 },
  ];

  it("interpolates when the bus pulled up to each stop", () => {
    // Stop at 415 m: reached 15 m before, at 400 m, 30 s in.
    const [t] = reachedTimes(progress, [415]);
    expect(t).toBe(30_000);
  });

  it("gives no answer where it was already past, the fixes are too far apart, or it isn't there yet", () => {
    expect(reachedTimes(progress, [50, 700, 2000])).toEqual([undefined, undefined, undefined]);
  });
});
