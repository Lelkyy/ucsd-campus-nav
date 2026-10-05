import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CampusSearch, type SearchHit } from "./campusSearch.ts";
import type { ClassMeeting } from "./schedule.ts";
import type { CourseSections } from "./sections.ts";
import type { Building, Place } from "./types.ts";

const buildings = JSON.parse(readFileSync(new URL("../../../apps/web/public/data/buildings.json", import.meta.url), "utf8")) as Building[];
const places: Place[] = [
  { id: "lingo-revelle", name: "Revelle bus stop", aliases: ["Revelle stop"], points: [[0, 0]], kind: "lingo" },
  { id: "saved-home", name: "Home", aliases: [], points: [[0, 0]], kind: "saved" },
  { id: "stop-revelle", name: "Revelle College", aliases: [], points: [[0, 0]], kind: "stop" },
];
const courses: CourseSections[] = [
  { code: "CSE 11", title: "Accelerated Intro to Programming", meetings: [["A00", "LE", "C", "TuTh", "", "1100", "1220", "CENTR", "115"]] },
  { code: "CSE 12", title: "Basic Data Structures", meetings: [["A00", "LE", "C", "MWF", "", "0900", "0950", "WLH", "2001"]] },
  { code: "MATH 20C", title: "Calculus and Analytic Geometry", meetings: [["A00", "LE", "C", "MWF", "", "1000", "1050", "PCYNH", "109"]] },
];
const search = new CampusSearch({ buildings, places, courses });
const label = (h: SearchHit) =>
  h.kind === "room"
    ? `room ${h.building.name} ${h.room}`
    : h.kind === "building"
      ? `building ${h.building.name}`
      : h.kind === "place"
        ? `place ${h.place.name}`
        : h.kind === "course"
          ? `course ${h.course.code}`
          : `class ${h.meeting.course}`;
const first = (q: string) => label(search.search(q)[0]);

describe("CampusSearch", () => {
  it("finds rooms however they're typed", () => {
    for (const q of ["WLH 2001", "wlh2001", "wlh 2001", "2001 WLH", "warren lecture hall 2001"]) {
      expect(first(q), q).toBe("room Warren Lecture Hall 2001");
    }
    expect(first("CENTR 115")).toBe("room Center Hall 115");
    expect(first("centr115")).toBe("room Center Hall 115");
    expect(search.search("CENTR 115")[0]).toMatchObject({ scheduled: true });
  });

  it("lists rooms while you type the number", () => {
    for (const q of ["WLH 20", "WLH 200"]) {
      const rooms = search.search(q).filter((h) => h.kind === "room");
      expect(rooms.length, q).toBeGreaterThan(1);
      expect(rooms.every((h) => h.kind === "room" && h.room.startsWith(q.split(" ")[1]) && h.scheduled)).toBe(true);
    }
  });

  it("ranks a matching building above course titles", () => {
    expect(first("literature")).toBe("building Halicioglu Data Science Institute"); // its old name
    expect(first("revelle")).not.toMatch(/^course/);
    // A student name is among the first few for its college.
    expect(search.search("revelle").slice(0, 3).some((h) => h.kind === "place" && h.place.id === "lingo-revelle")).toBe(true);
  });

  it("finds buildings by code, name, part of a name and with typos", () => {
    expect(first("CSE")).toBe("building Computer Science & Engineering");
    expect(first("wlh")).toBe("building Warren Lecture Hall");
    expect(first("geisel")).toBe("building Geisel Library");
    expect(first("giesel library")).toBe("building Geisel Library");
    expect(first("warren lec")).toBe("building Warren Lecture Hall");
    expect(first("price")).toMatch(/^building Price Center/);
    expect(first("HDSI")).toBe("building Halicioglu Data Science Institute");
  });

  it("finds courses and where they're taught", () => {
    expect(search.search("CSE 11")[0]).toMatchObject({ kind: "course", room: "115" });
    expect(first("cse11")).toBe("course CSE 11");
    expect(first("math 20c")).toBe("course MATH 20C");
    expect(search.search("data structures").some((h) => h.kind === "course" && h.course.code === "CSE 12")).toBe(true);
  });

  it("puts your own classes first", () => {
    const wlh = buildings.find((b) => b.name === "Warren Lecture Hall")!;
    const mine: ClassMeeting[] = [{ id: "1", course: "CSE 12", type: "LE", buildingId: wlh.id, buildingCode: "WLH", room: "2001", days: ["M"], start: "09:00" }];
    expect(label(search.search("cse 12", { classes: mine })[0])).toBe("class CSE 12");
  });

  it("finds student place names", () => {
    expect(first("revelle bus stop")).toBe("place Revelle bus stop");
    expect(search.search("revelle stop").some((h) => h.kind === "place")).toBe(true);
    // Student names before stops.
    const revelle = search.search("revelle").filter((h) => h.kind === "place");
    expect(revelle.map((h) => h.kind === "place" && h.place.id)).toEqual(["lingo-revelle", "stop-revelle"]);
  });

  it("returns nothing for nothing", () => {
    expect(search.search("   ")).toEqual([]);
  });
});
