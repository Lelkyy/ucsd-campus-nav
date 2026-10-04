import { describe, expect, it } from "vitest";
import { CampusGraph } from "./graph.ts";
import { entranceTargets, floorFromRoom, insideHints } from "./indoor.ts";
import { buildSteps } from "./instructions.ts";
import { RouteTracker, currentStepIndex } from "./nav.ts";
import { PROFILES, findRoute } from "./route.ts";
import { searchPlaces } from "./search.ts";
import { EdgeKind, type Building, type Place } from "./types.ts";

describe("floorFromRoom", () => {
  it.each([
    ["2001", "2"],
    ["115", "1"],
    ["B210", "B"],
    ["E209", "2"],
    ["0132", "0"],
  ])("%s is on floor %s", (room, floor) => {
    expect(floorFromRoom(room)?.floor).toBe(floor);
  });

  it("doesn't guess for odd room names", () => {
    expect(floorFromRoom("THEA")).toBeNull();
  });
});

describe("RouteTracker", () => {
  // ~111 m due north.
  const t = new RouteTracker([
    [0, 0],
    [0, 0.001],
  ]);

  it("measures progress and distance off the route", () => {
    const at = t.locate([0.0001, 0.0005]);
    expect(at.along).toBeCloseTo(55.7, 0);
    expect(at.offRoute).toBeCloseTo(11.1, 0);
  });

  it("interpolates points along the route", () => {
    expect(t.pointAt(t.total / 2)[1]).toBeCloseTo(0.0005, 6);
  });
});

describe("buildSteps", () => {
  // 0 ── 1 (junction) ── 2 north on "Library Walk", then east from 1 to 3 on "Lyman Lane".
  //            │
  //            3
  const g = new CampusGraph({
    version: 1,
    generatedAt: "",
    attribution: "",
    bbox: [0, 0, 1, 1],
    coords: [0, 0, 0, 0.001, 0, 0.002, 0.001, 0.001],
    edges: [0, 1, EdgeKind.Path, 1, 2, EdgeKind.Path, 1, 3, EdgeKind.Path],
    components: [0, 0, 0, 0],
    mainComponent: 0,
    bikeComponents: [0, 0, 0, 0],
    mainBikeComponent: 0,
    names: ["Library Walk", "Lyman Lane"],
    edgeNames: [0, 0, 1],
  });

  it("turns at junctions, using path names", () => {
    const r = findRoute(g, 0, [3], { profile: PROFILES.walk })!;
    const steps = buildSteps(g, r, "Center Hall");
    expect(steps.map((s) => s.text)).toEqual(["Head north on Library Walk", "Turn right onto Lyman Lane", "Arrive at Center Hall"]);
    expect(steps[0].distance).toBeCloseTo(111, 0);
    expect(currentStepIndex(steps, 120)).toBe(1);
  });
});

describe("doors", () => {
  const building: Building = {
    id: "b",
    name: "Hall",
    aliases: [],
    center: [0, 0],
    targets: [1, 2, 3],
    entranceCount: 3,
    access: "walk",
    entrances: [
      { lngLat: [0, 0.0001], node: 1, kind: "main" },
      { lngLat: [0.0001, 0], node: 2, kind: "yes", wheelchair: "yes" },
      { lngLat: [0, -0.0001], node: 3, kind: "emergency" },
    ],
  };
  const coord = (n: number) => building.entrances!.find((d) => d.node === n)!.lngLat;

  it("never routes to an emergency exit", () => {
    expect(entranceTargets(building, coord)).toEqual([1, 2]);
  });

  it("prefers the wheelchair-accessible door for step-free routes", () => {
    expect(entranceTargets(building, coord, { stepFree: true })).toEqual([2]);
  });

  it("describes the door the route ends at", () => {
    const route = { legs: [{ mode: "walk", nodes: [0, 1], coordinates: [[0, 0.001], [0, 0.0001]] }], coordinates: [[0, 0.001], [0, 0.0001]] };
    const hints = insideHints(building, "2001", undefined, route as never);
    expect(hints.enterBy).toBe("the main entrance on the north side");
    expect(hints.floor?.label).toBe("Floor 2");
  });
});

describe("searchPlaces", () => {
  const places: Place[] = [
    { id: "a", name: "Revelle bus stop", aliases: ["Revelle stop"], points: [[0, 0]], kind: "lingo" },
    { id: "b", name: "Revelle College", aliases: [], points: [[0, 0]], kind: "stop" },
  ];
  it("finds student names and stops, student names first", () => {
    expect(searchPlaces(places, "revelle").map((p) => p.id)).toEqual(["a", "b"]);
    expect(searchPlaces(places, "revelle stop")[0].id).toBe("a");
  });
});
