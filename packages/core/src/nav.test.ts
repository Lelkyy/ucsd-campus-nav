import { describe, expect, it } from "vitest";
import { CampusGraph } from "./graph.ts";
import { entranceTargets, findRoom, floorFromRoom, floorPhrase, floorToLevel, insideHints, levelLabel, levelsOf, roomFloor } from "./indoor.ts";
import { buildSteps } from "./instructions.ts";
import { RouteTracker, currentStepIndex } from "./nav.ts";
import { PROFILES, findRoute } from "./route.ts";
import { EdgeKind, type Building, type IndoorRoom } from "./types.ts";

describe("floorFromRoom", () => {
  it.each([
    ["2001", "2"],
    ["115", "1"],
    ["B210", "B"],
    ["E209", "2"],
    ["0132", "0"],
    ["1E106", "1"],
    ["2A03", "2"],
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

describe("indoor floors", () => {
  it("reads OSM levels, including ranges and lists", () => {
    expect(levelsOf("2")).toEqual([2]);
    expect(levelsOf("0-3")).toEqual([0, 1, 2, 3]);
    expect(levelsOf("-1;0;1")).toEqual([-1, 0, 1]);
    expect(levelsOf(undefined)).toEqual([]);
  });

  it("labels OSM levels with US floor numbers", () => {
    expect(levelLabel("0")).toBe("Floor 1 (ground)");
    expect(levelLabel("2")).toBe("Floor 3");
    expect(levelLabel("-1")).toBe("Basement");
    expect(floorToLevel("3")).toBe(2);
    expect(floorToLevel("B")).toBe(-1);
  });

  const rooms: IndoorRoom[] = [
    { ref: "3109", level: "2", center: [0, 0], outline: [[0, 0], [0, 1], [1, 1], [0, 0]], kind: "room", source: "osm" },
    { level: "2", center: [0, 0], outline: [[0, 0], [1, 0], [1, 1], [0, 0]], kind: "corridor", source: "osm" },
    { ref: "1202", level: "0", center: [0, 0], outline: [[0, 0], [0, 1], [1, 1], [0, 0]], kind: "room", source: "osm" },
    { ref: "3109", level: "2", center: [5, 5], kind: "room", source: "pinned" },
  ];

  it("finds rooms, preferring a student's pin", () => {
    expect(findRoom(rooms, "3109")?.source).toBe("pinned");
    expect(findRoom(rooms, "1202")?.level).toBe("0");
    expect(findRoom(rooms, "9999")).toBeUndefined();
  });

  it("says roughly where a room is", () => {
    const say = (room: string) => floorPhrase(roomFloor(rooms, room)!);
    expect(say("1202")).toBe("on the first floor"); // mapped on OSM level 0
    expect(say("3109")).toBe("on the third floor"); // pinned on level 2
    expect(say("2001")).toBe("on the second floor"); // from the number
    expect(say("B210")).toBe("in the basement");
    expect(roomFloor(rooms, "Auditorium")).toBeUndefined();
  });
});
