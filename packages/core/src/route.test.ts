import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CampusGraph } from "./graph.ts";
import { PROFILES, findRoute, findRouteArriveBy } from "./route.ts";
import { nextClass, type ClassMeeting } from "./schedule.ts";
import { formatCourseCode, searchCourses, sectionChoices, type CourseSections, type SectionsData } from "./sections.ts";
import { TransitNetwork, type TransitData } from "./transit.ts";
import { checkBusRoute } from "./plan.ts";
import { EdgeKind, type Building, type GraphData } from "./types.ts";

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

  it("counts a bus that saves the walk as realistic, and one that doesn't as not", () => {
    const busR = findRoute(g, 0, [1], { transit, departAt: at(10), walkWeight: 10 })!;
    const walkR = findRoute(g, 0, [1], { departAt: at(10) })!;
    expect(checkBusRoute(busR, walkR).ok).toBe(true);
    expect(checkBusRoute(walkR, walkR).ok).toBe(false);
    const late = findRoute(g, 0, [1], { transit, departAt: at(9), walkWeight: 10 })!; // waits 75 min
    expect(checkBusRoute(late, findRoute(g, 0, [1], { departAt: at(9) })).ok).toBe(false);
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
