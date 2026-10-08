import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { distanceMeters } from "./geo.ts";
import { CampusGraph } from "./graph.ts";
import { PROFILES, findRoute, findRouteArriveBy, hillFactor, rideFactor, rideRuns, usesGap, type MoveLeg, type Route } from "./route.ts";
import { dayClasses, defaultPick, groupOverlaps, nextClass, startOn, type ClassMeeting } from "./schedule.ts";
import { formatCourseCode, searchCourses, sectionChoices, type CourseSections, type SectionsData } from "./sections.ts";
import { TransitNetwork, type TransitData } from "./transit.ts";
import { checkBusRoute, planRoute } from "./plan.ts";
import { transitOptions } from "./transitOptions.ts";
import { buildSteps } from "./instructions.ts";
import { BikeDir, EdgeKind, NO_ELEVATION, type Building, type GraphData, type IndoorData, type LngLat } from "./types.ts";

// Small synthetic graph, ~111 m per 0.001° of latitude:
//
//   0 ──path── 1 ──path── 2
//   │                     │
//   └──steps── 3 ──steps──┘   (shorter, but stairs)
const tiny: GraphData = {
  version: 1,
  generatedAt: "",
  attribution: "",
  bbox: [0, 0, 1, 1],
  coords: [0, 0, 0.001, 0.001, 0.002, 0, 0.001, 0],
  edges: [0, 1, EdgeKind.Path, 1, 2, EdgeKind.Path, 0, 3, EdgeKind.Steps, 3, 2, EdgeKind.Steps],
  components: [0, 0, 0, 0],
  mainComponent: 0,
  bikeComponents: [0, 0, 0, 0],
  mainBikeComponent: 0,
};

describe("free points", () => {
  // One straight path, ~1.1 km north-south, with nodes only at its ends.
  const line = new CampusGraph({
    ...tiny,
    coords: [0, 0, 0, 0.01],
    edges: [0, 1, EdgeKind.Path],
    components: [0, 0],
    bikeComponents: [0, 0],
  });

  it("join the nearest path at its closest point, not its nearest node", () => {
    // ~11 m east of the path's middle, ~550 m from either end.
    const p = planRoute(line, { kind: "point", lngLat: [0.0001, 0.005], label: "Here" }, { kind: "point", lngLat: [0, 0.01], label: "End" }, { profile: PROFILES.walk });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // The dotted line is the short perpendicular to the path...
    const [from, to] = p.connectors[0];
    expect(distanceMeters(from, to)).toBeLessThan(12);
    expect(to[0]).toBeCloseTo(0, 6);
    expect(to[1]).toBeCloseTo(0.005, 4);
    // ...and the route runs along the path from there: about half its length, not all of it.
    expect(p.route.meters).toBeGreaterThan(540);
    expect(p.route.meters).toBeLessThan(570);
    expect(p.route.coordinates[0][1]).toBeCloseTo(0.005, 4);
  });
});

describe("what walkers keep off", () => {
  // 0 ── direct (~222 m) ── 2, or a footpath detour 0 ── 1 ── 2 bowing out `bow` degrees.
  const choice = (direct: EdgeKind, bow: number) =>
    new CampusGraph({
      ...tiny,
      coords: [0, 0, 0.001, bow, 0.002, 0, 0.001, 0],
      edges: [0, 1, EdgeKind.Path, 1, 2, EdgeKind.Path, 0, 3, direct, 3, 2, direct],
    });
  const takesDirect = (g: CampusGraph) => findRoute(g, 0, [2], { profile: PROFILES.walk })!.coordinates.some(([lon, lat]) => lon === 0.001 && lat === 0);

  it("takes a bike path only for a real time saving", () => {
    // Footpath ~4% longer: stay on it.
    expect(takesDirect(choice(EdgeKind.Bike, 0.0003))).toBe(false);
    // Footpath ~80% longer: the bike path is worth it.
    expect(takesDirect(choice(EdgeKind.Bike, 0.0015))).toBe(true);
  });

  it("walks the long way round rather than along a road with no sidewalk", () => {
    expect(takesDirect(choice(EdgeKind.Road, 0.0015))).toBe(false);
    expect(takesDirect(choice(EdgeKind.Sidewalk, 0.0015))).toBe(true);
  });
});

describe("hills", () => {
  // One ~111 m path climbing 11 m (a 10% grade) from node 0 to node 1.
  const hill = (elevation?: number[]) =>
    new CampusGraph({ ...tiny, coords: [0, 0, 0, 0.001], edges: [0, 1, EdgeKind.Path], components: [0, 0], bikeComponents: [0, 0], elevation });
  const slope = hill([0, 111]);
  const seconds = (g: CampusGraph, from: number, to: number) => findRoute(g, from, [to], { profile: PROFILES.walk })!.seconds;

  it("walks slower uphill than down, and level ground at the usual pace", () => {
    const level = seconds(hill(), 0, 1);
    expect(level).toBeCloseTo(111 / 1.3, -1);
    const up = seconds(slope, 0, 1);
    const down = seconds(slope, 1, 0);
    // Tobler: ~0.70x level speed up a 10% grade, ~1.19x at 5% down, ~1.0x at 10% down.
    expect(up / level).toBeGreaterThan(1.35);
    expect(up / level).toBeLessThan(1.5);
    expect(down / level).toBeGreaterThan(0.95);
    expect(down / level).toBeLessThan(1.05);
    expect(hillFactor(-0.05)).toBeGreaterThan(1.18);
    expect(hillFactor(0)).toBe(1);
    expect(hillFactor(0.05)).toBeCloseTo(0.84, 2);
  });

  it("rides slower uphill and faster down, and walks the bike up a climb too steep to ride", () => {
    const ride = (g: CampusGraph, from: number, to: number) => findRoute(g, from, [to], { profile: PROFILES.bike })!.legs[0] as MoveLeg;
    // A ~111 m road climbing at a 5% grade, and one at 20%.
    const road = (rise: number) =>
      new CampusGraph({ ...tiny, coords: [0, 0, 0, 0.001], edges: [0, 1, EdgeKind.BikeOnly], components: [0, 0], bikeComponents: [0, 0], elevation: [0, rise] });
    const level = ride(road(0), 0, 1).seconds;
    expect(level).toBeCloseTo(111 / 5, 0);
    const gentle = road(55); // 5.5 m up
    expect(ride(gentle, 0, 1).seconds / level).toBeGreaterThan(1.5);
    expect(ride(gentle, 1, 0).seconds / level).toBeLessThan(0.8);
    expect(ride(gentle, 0, 1).pushMeters).toBe(0);
    // 20% up: quicker to get off and walk.
    const steep = ride(road(222), 0, 1);
    expect(steep.pushMeters).toBeGreaterThan(100);
    expect(rideFactor(0)).toBe(1);
  });

  it("counts bridges, tunnels and floors as level", () => {
    expect(seconds(hill([0, NO_ELEVATION]), 0, 1)).toBeCloseTo(seconds(hill(), 0, 1), 3);
  });
});

describe("cutting across open ground", () => {
  // Two paths ~19 m apart: A (0 -> 1, north) and B (2 -> 3, south), with a cut 1 - 2 between
  // them. Without it, the walk goes round via `round` (node 4 and beyond).
  const lawn = (round: number[], roundEdges: number[]) =>
    new CampusGraph({
      ...tiny,
      coords: [0, 0, 0, 0.001, 0.0002, 0.001, 0.0002, 0, ...round],
      edges: [0, 1, EdgeKind.Path, 2, 3, EdgeKind.Path, 1, 2, EdgeKind.Gap, ...roundEdges],
      components: Array(4 + round.length / 2).fill(0),
      bikeComponents: Array(4 + round.length / 2).fill(0),
    });
  // The paths only meet ~220 m further north: going round is ~685 m against ~240 m across.
  const farRound = lawn([0, 0.003, 0.0002, 0.003], [1, 4, EdgeKind.Path, 4, 5, EdgeKind.Path, 5, 2, EdgeKind.Path]);
  // A short footpath bend joins them right there: ~30 m against ~19 m across.
  const nearRound = lawn([0.0001, 0.0011], [1, 4, EdgeKind.Path, 4, 2, EdgeKind.Path]);
  const across = (g: CampusGraph, r: Route | null) => !!r && usesGap(g, r);

  it("cuts across when it saves a real part of the trip", () => {
    const r = findRoute(farRound, 0, [3], { profile: PROFILES.walk });
    expect(across(farRound, r)).toBe(true);
    expect(r!.meters).toBeLessThan(260);
    expect(buildSteps(farRound, r!, "there").some((s) => /cut across/.test(s.text))).toBe(true);
  });

  it("stays on the paths when the saving is small for the trip", () => {
    // ~11 m (~8 s) shorter across: under a tenth of the trip and under 20 s.
    const r = findRoute(nearRound, 0, [3], { profile: PROFILES.walk });
    expect(across(nearRound, r)).toBe(false);
  });

  it("only on foot, and not when avoiding stairs", () => {
    expect(across(farRound, findRoute(farRound, 0, [3], { profile: PROFILES.accessible }))).toBe(false);
    expect(across(farRound, findRoute(farRound, 0, [3], { profile: PROFILES.bike }))).toBe(false);
  });
});

describe("parking lots", () => {
  // An aisle-less lot: paths on its west (0 - 1) and east (2 - 3) edges, ~55 m apart, joined only
  // far to the north; a walk straight across the lot (1 - 2).
  const lot = new CampusGraph({
    ...tiny,
    coords: [0, 0, 0, 0.0005, 0.0005, 0.0005, 0.0005, 0, 0, 0.003, 0.0005, 0.003],
    edges: [0, 1, EdgeKind.Path, 2, 3, EdgeKind.Path, 1, 2, EdgeKind.Lot, 1, 4, EdgeKind.Path, 4, 5, EdgeKind.Path, 5, 2, EdgeKind.Path],
    components: [0, 0, 0, 0, 0, 0],
    bikeComponents: [0, 0, 0, 0, 0, 0],
  });

  it("walks straight across, as ordinary walking", () => {
    const r = findRoute(lot, 0, [3], { profile: PROFILES.walk })!;
    expect(r.meters).toBeLessThan(170);
    expect(buildSteps(lot, r, "there").some((s) => /cross the parking lot/.test(s.text))).toBe(true);
    // Step-free too; a bike is walked across.
    expect(findRoute(lot, 0, [3], { profile: PROFILES.accessible })!.meters).toBeLessThan(170);
    const ride = findRoute(lot, 0, [3], { profile: PROFILES.bike })!.legs[0] as MoveLeg;
    expect(ride.meters).toBeLessThan(170);
    expect(ride.pushMeters).toBeGreaterThan(50);
  });
});

describe("cyclists keep right", () => {
  // A divided road: two one-way carriageways between 0 (south) and 2 (north), the east one
  // northbound (0 -> 1 -> 2), the west one southbound (2 -> 3 -> 0), each ~225 m; the sides
  // bow out by `east` and `west` degrees, so one can be made a little longer.
  const divided = (
    kind: EdgeKind,
    dir: number[] = [BikeDir.NoBackward, BikeDir.NoBackward, BikeDir.NoBackward, BikeDir.NoBackward],
    east = 0.0002,
    west = 0.0002,
  ) =>
    new CampusGraph({
      ...tiny,
      coords: [0, 0, east, 0.001, 0, 0.002, -west, 0.001],
      edges: [0, 1, kind, 1, 2, kind, 2, 3, kind, 3, 0, kind],
      bikeDir: dir,
    });
  const east = (r: Route) => r.coordinates.some(([lon]) => lon > 0);

  it("rides each carriageway only with the traffic", () => {
    // The west side is longer, but going south it's the one to ride.
    const g = divided(EdgeKind.BikeOnly, undefined, 0.0002, 0.0004);
    expect(east(findRoute(g, 0, [2], { profile: PROFILES.bike })!)).toBe(true);
    expect(east(findRoute(g, 2, [0], { profile: PROFILES.bike })!)).toBe(false);
    // Without the one-way, the shorter east side would do.
    expect(east(findRoute(divided(EdgeKind.BikeOnly, [0, 0, 0, 0], 0.0002, 0.0004), 2, [0], { profile: PROFILES.bike })!)).toBe(true);
    // Walkers don't care which side.
    const w = divided(EdgeKind.Sidewalk);
    expect(findRoute(w, 2, [0], { profile: PROFILES.walk })).not.toBeNull();
  });

  it("never rides the wrong way; walks the bike where there's a sidewalk", () => {
    // Only the east carriageway, northbound: southbound there's no riding it at all...
    const one = new CampusGraph({ ...tiny, coords: [0, 0, 0.0002, 0.001, 0, 0.002], edges: [0, 1, EdgeKind.BikeOnly, 1, 2, EdgeKind.BikeOnly], components: [0, 0, 0], bikeComponents: [0, 0, 0], bikeDir: [BikeDir.NoBackward, BikeDir.NoBackward] });
    expect(findRoute(one, 2, [0], { profile: PROFILES.bike })).toBeNull();
    // ...but with a sidewalk you get off and walk it.
    const walkable = new CampusGraph({ ...tiny, coords: [0, 0, 0.0002, 0.001, 0, 0.002], edges: [0, 1, EdgeKind.Sidewalk, 1, 2, EdgeKind.Sidewalk], components: [0, 0, 0], bikeComponents: [0, 0, 0], bikeDir: [BikeDir.NoBackward, BikeDir.NoBackward] });
    const r = findRoute(walkable, 2, [0], { profile: PROFILES.bike })!;
    const leg = r.legs[0];
    expect(leg.mode === "bike" && leg.pushMeters).toBeGreaterThan(200);
    expect(buildSteps(walkable, r, "there")[0].text).toMatch(/^Walk your bike/);
  });

  it("prefers a road with a bike lane in its direction", () => {
    // Two-way roads; the east one is a little longer but has a northbound lane.
    const g = divided(EdgeKind.BikeOnly, [BikeDir.LaneForward, BikeDir.LaneForward, 0, 0], 0.0003, 0.0002);
    expect(east(findRoute(g, 0, [2], { profile: PROFILES.bike })!)).toBe(true);
    // Lanes on both sides, each for riding along its edges: northbound on the east side,
    // southbound (2 -> 3 -> 0) on the west. Going south, only the west one helps.
    const h = divided(EdgeKind.BikeOnly, [BikeDir.LaneForward, BikeDir.LaneForward, BikeDir.LaneForward, BikeDir.LaneForward], 0.0002, 0.0003);
    expect(east(findRoute(h, 2, [0], { profile: PROFILES.bike })!)).toBe(false);
  });

  it("draws rides along roads on the right-hand side", () => {
    const g = divided(EdgeKind.BikeOnly);
    const r = findRoute(g, 0, [2], { profile: PROFILES.bike })!;
    const runs = rideRuns(g, PROFILES.bike, r.legs[0] as MoveLeg);
    expect(runs).toHaveLength(1);
    expect(runs[0].keepRight).toBe(true);
  });
});

describe("findRoute (walking)", () => {
  const g = new CampusGraph(tiny);
  const via = (lngLats: number[][]) => lngLats.map(([lon]) => lon);

  it("takes the short stairs when walking", () => {
    const r = findRoute(g, 0, [2], { profile: PROFILES.walk })!;
    expect(via(r.coordinates)).toEqual([0, 0.001, 0.002]);
    expect(r.coordinates[1][1]).toBe(0); // through node 3, not node 1
    expect(r.stairSegments).toBe(2);
    expect(r.meters).toBeCloseTo(222.4, 0);
    expect(r.usesTransit).toBe(false);
  });

  it("avoids stairs on the accessible profile", () => {
    const r = findRoute(g, 0, [2], { profile: PROFILES.accessible })!;
    expect(r.coordinates[1][1]).toBeCloseTo(0.001);
    expect(r.stairSegments).toBe(0);
  });

  it("stops at the nearest of several targets", () => {
    const r = findRoute(g, 0, [2, 1], { profile: PROFILES.accessible })!;
    expect(r.coordinates).toHaveLength(2);
  });

  it("returns null when nothing is reachable", () => {
    const cut: GraphData = { ...tiny, edges: [0, 3, EdgeKind.Steps] };
    expect(findRoute(new CampusGraph(cut), 0, [2])).toBeNull();
  });

  it("snaps points to the nearest node", () => {
    expect(g.nearestNode([0.0019, 0.0001])).toBe(2);
  });
});

describe("findRoute (bike)", () => {
  //   0 ──footway── 1        footway: walk the bike (slow)
  //   │             │
  //   └──road──── 2 ┘        bike-only road: longer but rideable
  const g = new CampusGraph({
    ...tiny,
    coords: [0, 0, 0, 0.002, 0.001, 0.001],
    edges: [0, 1, EdgeKind.Path, 0, 2, EdgeKind.BikeOnly, 2, 1, EdgeKind.BikeOnly],
    components: [0, 0, 1],
    bikeComponents: [0, 0, 0],
  });

  it("rides the longer road instead of pushing along the footway", () => {
    const r = findRoute(g, 0, [1], { profile: PROFILES.bike })!;
    expect(r.coordinates).toHaveLength(3);
    expect(r.legs[0].mode).toBe("bike");
    expect(r.legs[0].mode !== "bus" && r.legs[0].pushMeters).toBe(0);
  });

  it("walkers never use bike-only roads", () => {
    const r = findRoute(g, 0, [1], { profile: PROFILES.walk })!;
    expect(r.coordinates).toHaveLength(2);
    expect(findRoute(g, 0, [2], { profile: PROFILES.walk })).toBeNull();
  });

  it("is faster than walking the same trip", () => {
    const bike = findRoute(g, 0, [1], { profile: PROFILES.bike })!;
    const walk = findRoute(g, 0, [1], { profile: PROFILES.walk })!;
    expect(bike.minutes).toBeLessThan(walk.minutes);
  });
});

describe("sections", () => {
  const cse12: CourseSections = {
    code: "CSE 12",
    title: "Basic Data Structures",
    meetings: [
      ["001-000-LE", "LE", "C", "MWF", "", "0800", "0850", "WLH", "2001"],
      ["001-000-LE", "LE", "F", "", "12/07/2026", "0800", "1059", "WLH", "2001"],
      ["001-001-DI", "DI", "C", "M", "", "1600", "1650", "CENTR", "212"],
      ["001-002-DI", "DI", "C", "M", "", "1700", "1750", "CENTR", "212"],
    ],
  };

  it("pairs the lecture and final with each discussion", () => {
    const choices = sectionChoices(cse12);
    expect(choices.map((c) => c.id)).toEqual(["001-001", "001-002"]);
    expect(choices[0].meetings.map((m) => m.type)).toEqual(["LE", "FI", "DI"]);
    const final = choices[0].meetings[1];
    expect(final.date).toBe("2026-12-07");
    expect(final.start).toBe("08:00");
    expect(choices[0].meetings[0].days).toEqual(["M", "W", "F"]);
  });

  it("formats and finds course codes", () => {
    expect(formatCourseCode("CSE-012")).toBe("CSE 12");
    expect(formatCourseCode("AWP-004B")).toBe("AWP 4B");
    expect(searchCourses([cse12], "cse12")[0].code).toBe("CSE 12");
    expect(searchCourses([cse12], "CSE 012")[0].code).toBe("CSE 12");
    expect(searchCourses([cse12], "data struct")[0].code).toBe("CSE 12");
  });
});

describe("findRoute (shuttle)", () => {
  // A 6.6 km straight path (0 -> 1 -> 2), with a shuttle from node 0 to node 2.
  const line: GraphData = {
    ...tiny,
    coords: [0, 0, 0, 0.03, 0, 0.06],
    edges: [0, 1, EdgeKind.Path, 1, 2, EdgeKind.Path],
    components: [0, 0, 0],
    bikeComponents: [0, 0, 0],
  };
  const g = new CampusGraph(line);
  const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m); // Wednesday
  const transitData: TransitData = {
    version: 1,
    generatedAt: "",
    feeds: [],
    stops: [
      { id: "a", name: "Stop A", lngLat: [0, 0], node: 0 },
      { id: "b", name: "Stop B", lngLat: [0, 0.06], node: 2 },
    ],
    routes: [{ id: "r", short: "X", long: "Express", color: "#ff0000", feed: "triton", mode: "shuttle" }],
    fares: {},
    services: [{ days: [true, true, true, true, true, false, false], start: "20260901", end: "20261231", added: [], removed: [] }],
    patterns: [
      {
        route: 0,
        headsign: "Stop B",
        stops: [0, 1],
        shape: [[0, 0], [0, 0.06]],
        shapeIndex: [0, 1],
        trips: [
          { service: 0, times: [10 * 3600, 10 * 3600 + 600] },
          { service: 0, times: [10.5 * 3600, 10.5 * 3600 + 600] },
        ],
      },
    ],
  };
  const transit = new TransitNetwork(transitData, g);

  it("rides the next departure when it's faster than walking", () => {
    const r = findRoute(g, 0, [2], { transit, departAt: at(9, 55) })!;
    expect(r.usesTransit).toBe(true);
    const bus = r.legs.find((l) => l.mode === "bus")!;
    expect(bus.mode === "bus" && bus.departs.getHours()).toBe(10);
    expect(r.arriveAt.getTime()).toBe(at(10, 10).getTime());
  });

  it("walks when there's no service that day", () => {
    const r = findRoute(g, 0, [2], { transit, departAt: new Date(2026, 9, 10, 9, 55) })!; // Saturday
    expect(r.usesTransit).toBe(false);
  });

  it("arrive-by picks the latest bus that still makes it", () => {
    const r = findRouteArriveBy(g, 0, [2], at(10, 45), { transit })!;
    const bus = r.legs.find((l) => l.mode === "bus")!;
    expect(bus.mode === "bus" && bus.departs.getTime()).toBe(at(10, 30).getTime());
    expect(r.arriveAt <= at(10, 45)).toBe(true);
  });
});

describe("bus mode: minimise walking", () => {
  // 1.1 km of path (0 -> 1), with a shuttle between the two ends.
  const g = new CampusGraph({
    ...tiny,
    coords: [0, 0, 0, 0.01],
    edges: [0, 1, EdgeKind.Path],
    components: [0, 0],
    bikeComponents: [0, 0],
  });
  const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
  const data: TransitData = {
    version: 1,
    generatedAt: "",
    feeds: [],
    stops: [
      { id: "a", name: "A", lngLat: [0, 0], node: 0 },
      { id: "b", name: "B", lngLat: [0, 0.01], node: 1 },
      { id: "c", name: "C", lngLat: [0, 0.01], node: 1 },
    ],
    routes: [{ id: "r", short: "L", long: "Loop", color: "#000", feed: "triton", mode: "shuttle" }],
    fares: {},
    services: [{ days: [true, true, true, true, true, true, true], start: "20260101", end: "20261231", added: [], removed: [] }],
    patterns: [
      // Leaves in 15 min, so walking (~14 min) gets there first.
      { route: 0, headsign: "B", stops: [0, 1], shape: [[0, 0], [0, 0.01]], shapeIndex: [0, 1], trips: [{ service: 0, times: [10.25 * 3600, 10.25 * 3600 + 300] }] },
    ],
  };
  const transit = new TransitNetwork(data, g);

  it("fastest-trip routing walks", () => {
    expect(findRoute(g, 0, [1], { transit, departAt: at(10) })!.usesTransit).toBe(false);
  });

  it("minimise-walking routing waits for the bus", () => {
    const r = findRoute(g, 0, [1], { transit, departAt: at(10), walkWeight: 10 })!;
    expect(r.usesTransit).toBe(true);
    expect(r.meters).toBeLessThan(10);
  });

  it("only counts transit when it's faster than walking", () => {
    // Leaving at 10:00: walking (~14 min) beats waiting for the 10:15 bus.
    const early = findRoute(g, 0, [1], { transit, departAt: at(10), walkWeight: 10 })!;
    expect(checkBusRoute(early, findRoute(g, 0, [1], { departAt: at(10) }))).toEqual({
      ok: false,
      reason: "Walking is faster for this trip.",
    });
    // Leaving at 10:13: the 10:15 bus arrives 10:20, walking arrives ~10:27.
    const late = findRoute(g, 0, [1], { transit, departAt: at(10, 13) })!;
    expect(late.usesTransit).toBe(true);
    expect(checkBusRoute(late, findRoute(g, 0, [1], { departAt: at(10, 13) })).ok).toBe(true);
    // No transit in the route at all.
    const walkR = findRoute(g, 0, [1], { departAt: at(10) })!;
    expect(checkBusRoute(walkR, walkR).ok).toBe(false);
  });

  it("lists walking and transit as options, shortest trip first", () => {
    const building = (node: number, id: string): Building => ({
      id,
      name: id,
      aliases: [],
      center: g.coord(node),
      targets: [node],
      entranceCount: 0,
      access: "walk",
    });
    const from = { kind: "building" as const, building: building(0, "A") };
    const to = { kind: "building" as const, building: building(1, "B") };
    // Leaving 10:00: walking takes ~14 min; the 10:15 bus is the shorter trip (leave later, ride 5 min).
    const options = transitOptions(g, from, to, { transit, timing: { departAt: at(10) } }).options;
    expect(options.map((o) => o.walkOnly)).toEqual([false, true]);
    expect(options[0].route.minutes).toBeLessThan(options[1].route.minutes);
    expect(options[0].boardings).toBe(1);
    // Never more than three.
    expect(transitOptions(g, from, to, { transit, timing: { departAt: at(10) }, max: 1 }).options).toHaveLength(1);
  });

  it("merges a loop that continues as its next run into one ride", () => {
    // A -- B -- C along a 2.2 km path; the loop runs A->B, then its next run B->C.
    const g3 = new CampusGraph({
      ...tiny,
      coords: [0, 0, 0, 0.01, 0, 0.02],
      edges: [0, 1, EdgeKind.Path, 1, 2, EdgeKind.Path],
      components: [0, 0, 0],
      bikeComponents: [0, 0, 0],
    });
    const loop = new TransitNetwork(
      {
        ...data,
        stops: [
          { id: "a", name: "A", lngLat: [0, 0], node: 0 },
          { id: "b", name: "B", lngLat: [0, 0.01], node: 1 },
          { id: "c", name: "C", lngLat: [0, 0.02], node: 2 },
        ],
        patterns: [
          { route: 0, headsign: "B", stops: [0, 1], shape: [[0, 0], [0, 0.01]], shapeIndex: [0, 1], trips: [{ service: 0, times: [36000, 36060] }] },
          { route: 0, headsign: "C", stops: [1, 2], shape: [[0, 0.01], [0, 0.02]], shapeIndex: [0, 1], trips: [{ service: 0, times: [36120, 36180] }] },
        ],
      },
      g3,
    );
    const r = findRoute(g3, 0, [2], { transit: loop, departAt: at(9, 58), walkWeight: 10 })!;
    const rides = r.legs.filter((l) => l.mode === "bus");
    expect(rides).toHaveLength(1);
    expect(rides[0].mode === "bus" && [rides[0].from.name, rides[0].to.name, rides[0].stopCount]).toEqual(["A", "C", 2]);
  });
});

describe("real campus data", () => {
  const dir = new URL("../../../apps/web/public/data/", import.meta.url);
  const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
  const graph = new CampusGraph(read<GraphData>("graph.json"));
  const buildings = read<Building[]>("buildings.json");
  const transit = new TransitNetwork(read<TransitData>("transit.json"), graph);
  const byName = (name: string) => buildings.find((b) => b.name === name)!;
  const start = byName("Price Center").targets[0];
  // A Wednesday morning during Fall 2026 shuttle service.
  const departAt = new Date(2026, 9, 7, 10, 0);

  it("routes Geisel Library -> Center Hall in a plausible walk", () => {
    const r = findRoute(graph, byName("Geisel Library").targets[0], byName("Center Hall").targets)!;
    expect(r.meters).toBeGreaterThan(150);
    expect(r.meters).toBeLessThan(700);
  });

  it("reaches every campus building on foot, or by shuttle where marked", () => {
    const failures = buildings.filter((b) => {
      const opts = b.access === "walk" ? {} : { transit, departAt };
      return !findRoute(graph, start, b.targets, opts);
    });
    expect(failures.map((b) => b.name)).toEqual([]);
  });

  it("keeps each floor plan to its own building", () => {
    const indoor = read<IndoorData>("indoor.json");
    const owners = new Map<string, string[]>();
    for (const [id, rooms] of Object.entries(indoor)) {
      const b = buildings.find((x) => x.id === id)!;
      expect(b, `indoor data for unknown building ${id}`).toBeDefined();
      for (const r of rooms.filter((r) => r.source === "osm")) {
        // Inside that building's walls...
        expect(b.outline!.some((ring) => inRing(r.center, ring)), `${r.ref ?? r.kind} outside ${b.name}`).toBe(true);
        // ...and listed under no other building.
        const key = `${r.center.join()}|${r.level}|${r.ref ?? r.kind}`;
        owners.set(key, [...new Set([...(owners.get(key) ?? []), id])]);
      }
    }
    expect([...owners.values()].filter((ids) => ids.length > 1)).toEqual([]);
  });

  it("reaches every campus building by bike", () => {
    const failures = buildings.filter((b) => !findRoute(graph, start, b.targets, { profile: PROFILES.bike }));
    expect(failures.map((b) => b.name)).toEqual([]);
  });

  const sectionsPath = new URL("sections.json", dir);
  it.runIf(existsSync(sectionsPath))("places every in-person meeting of the current term", () => {
    const { courses } = read<SectionsData>("sections.json");
    const codes = JSON.parse(readFileSync(new URL("../../../data/building-codes.json", import.meta.url), "utf8")) as {
      unplaced: Record<string, string>;
    };
    const used = new Set(courses.flatMap((c) => c.meetings.map((m) => m[7]).filter(Boolean)));
    const missing = [...used].filter((code) => !buildings.some((b) => b.aliases.includes(code)) && !codes.unplaced[code]);
    expect(missing).toEqual([]);
  });

  it("uses roads for walking only as connectors", () => {
    const roads = Array.from(graph.edgeKind).filter((k) => k === EdgeKind.Road).length;
    expect(roads / graph.edgeCount).toBeLessThan(0.1);
  });

  it("walks the sidewalks along roads", () => {
    const sidewalks = Array.from(graph.edgeKind).filter((k) => k === EdgeKind.Sidewalk).length;
    expect(sidewalks).toBeGreaterThan(1000);
    // Walked like a footpath, ridden like a road.
    expect(PROFILES.walk.speed[EdgeKind.Sidewalk]).toBe(PROFILES.walk.speed[EdgeKind.Path]);
    expect(PROFILES.bike.speed[EdgeKind.Sidewalk]).toBe(PROFILES.bike.speed[EdgeKind.Road]);
  });

  const roomsPath = new URL("../../../data/rooms.json", import.meta.url);
  it.runIf(existsSync(roomsPath))("accounts for every building code classes meet in", () => {
    const { rooms } = JSON.parse(readFileSync(roomsPath, "utf8")) as { rooms: Record<string, string[]> };
    const codes = JSON.parse(readFileSync(new URL("../../../data/building-codes.json", import.meta.url), "utf8")) as {
      notPlaces: string[];
      unplaced: Record<string, string>;
    };
    // Each code is on a reachable building, explicitly not a place, or a documented gap.
    const unaccounted = Object.keys(rooms).filter(
      (code) => !buildings.some((b) => b.aliases.includes(code)) && !codes.notPlaces.includes(code) && !codes.unplaced[code],
    );
    expect(unaccounted).toEqual([]);
    // Documented gaps that have since been placed should be removed from the list.
    const stale = Object.keys(codes.unplaced).filter((code) => buildings.some((b) => b.aliases.includes(code)));
    expect(stale).toEqual([]);
  });

  it("puts each building code on just one building", () => {
    const codes = JSON.parse(readFileSync(new URL("../../../data/building-codes.json", import.meta.url), "utf8")) as {
      codes: Record<string, string>;
    };
    const rooms = existsSync(roomsPath) ? (JSON.parse(readFileSync(roomsPath, "utf8")) as { rooms: Record<string, string[]> }).rooms : {};
    const shared = [...new Set([...Object.keys(codes.codes), ...Object.keys(rooms)])].flatMap((code) => {
      const on = buildings.filter((b) => b.aliases.includes(code)).map((b) => b.name);
      return on.length > 1 ? [`${code}: ${on.join(" / ")}`] : [];
    });
    expect(shared).toEqual([]);
    // Codes whose neighbors share a name or an alias list (TSS names the building).
    const at = (code: string) => buildings.find((b) => b.aliases.includes(code))?.name;
    expect(at("CNCB")).toBe("Center for Neural Circuits and Behavior");
    expect(at("MYR-A")).toBe("Mayer Hall Addition");
    expect(at("VAF")).toBe("Visual Arts Facility - Building 2");
    expect(at("UNEXG")).toBe("Extended Studies and Public Programs - Building G");
    expect(at("UNEXN")).toBe("Extended Studies and Public Programs - Building N");
  });
});

describe("nextClass", () => {
  const meetings: ClassMeeting[] = [
    { id: "a", course: "CSE 12", buildingId: "x", days: ["M", "W", "F"], start: "10:00" },
    { id: "b", course: "MATH 20C", buildingId: "y", days: ["Tu", "Th"], start: "09:30" },
  ];

  it("picks the next start today", () => {
    // Monday 2026-10-05 08:00
    const next = nextClass(meetings, new Date(2026, 9, 5, 8, 0))!;
    expect(next.meeting.id).toBe("a");
    expect(next.startsAt.getHours()).toBe(10);
  });

  it("rolls over to tomorrow after today's classes", () => {
    const next = nextClass(meetings, new Date(2026, 9, 5, 12, 0))!;
    expect(next.meeting.id).toBe("b");
    expect(next.startsAt.getDate()).toBe(6);
  });

  it("keeps a class that started a few minutes ago", () => {
    const next = nextClass(meetings, new Date(2026, 9, 5, 10, 5))!;
    expect(next.meeting.id).toBe("a");
  });
});

function inRing([x, y]: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe("dayClasses", () => {
  const meetings: ClassMeeting[] = [
    { id: "lab", course: "CSE 12", type: "LA", buildingId: "b", days: ["M"], start: "15:00", end: "15:50" },
    { id: "le", course: "CSE 12", type: "LE", buildingId: "b", days: ["M", "W", "F"], start: "09:00", end: "09:50" },
    { id: "di", course: "MATH 20C", type: "DI", buildingId: "c", days: ["Tu"], start: "10:00" },
    { id: "fi", course: "CSE 12", type: "FI", buildingId: "b", days: [], date: "2026-12-07", start: "08:00", end: "10:59" },
  ];

  it("lists a day's classes in order, with end times", () => {
    const monday = dayClasses(meetings, new Date(2026, 9, 5, 18, 0)); // Mon Oct 5, in the evening
    expect(monday.map((c) => c.meeting.id)).toEqual(["le", "lab"]);
    expect(monday[0].startsAt).toEqual(new Date(2026, 9, 5, 9, 0));
    expect(monday[0].endsAt).toEqual(new Date(2026, 9, 5, 9, 50));
    expect(dayClasses(meetings, new Date(2026, 9, 6)).map((c) => c.meeting.id)).toEqual(["di"]);
    expect(dayClasses(meetings, new Date(2026, 9, 10))).toEqual([]); // Saturday
  });

  it("includes exams only on their date", () => {
    expect(dayClasses(meetings, new Date(2026, 11, 7)).map((c) => c.meeting.id)).toEqual(["fi", "le", "lab"]);
    expect(startOn(meetings[3], new Date(2026, 11, 8))).toBeNull();
  });
});

describe("groupOverlaps", () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 5, h, m);
  const cls = (id: string, start: Date, end?: Date, type = "LE") => ({
    meeting: { id, course: id, type, buildingId: "b", days: [], start: "", date: "" } as ClassMeeting,
    startsAt: start,
    ...(end ? { endsAt: end } : {}),
  });

  it("keeps back-to-back classes apart and groups overlapping ones", () => {
    const groups = groupOverlaps([
      cls("a", at(9), at(9, 50)),
      cls("b", at(10), at(10, 50)), // starts after a ends
      cls("c", at(10, 30), at(11, 20)), // overlaps b
      cls("d", at(11), at(11, 50)), // overlaps c (so joins b's group)
      cls("e", at(11, 50), at(12, 40)), // starts as d ends
    ]);
    expect(groups.map((g) => g.map((c) => c.meeting.id))).toEqual([["a"], ["b", "c", "d"], ["e"]]);
  });

  it("assumes 50 minutes when there's no end time", () => {
    expect(groupOverlaps([cls("a", at(9)), cls("b", at(9, 45))]).length).toBe(1);
    expect(groupOverlaps([cls("a", at(9)), cls("b", at(9, 50))]).length).toBe(2);
  });

  it("picks an exam over a class, else the earlier one", () => {
    expect(defaultPick([cls("le", at(9)), cls("fi", at(9, 30), at(11), "FI")]).meeting.id).toBe("fi");
    expect(defaultPick([cls("x", at(9)), cls("y", at(9, 30))]).meeting.id).toBe("x");
  });
});
