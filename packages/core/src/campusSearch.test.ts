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
/** The schedule code, which the build puts first among a building's aliases. */
const codeOf = (b: Building) => b.aliases.find((a) => /^[A-Z][A-Z0-9-]{1,5}$/.test(a));

describe("CampusSearch", () => {
  it("finds rooms however they're typed", () => {
    for (const q of ["WLH 2001", "wlh2001", "wlh 2001", "2001 WLH", "warren lecture hall 2001"]) {
      expect(first(q), q).toBe("room Warren Lecture Hall 2001");
    }
    expect(first("CENTR 115")).toBe("room Center Hall 115");
    expect(first("centr115")).toBe("room Center Hall 115");
    expect(search.search("CENTR 115")[0]).toMatchObject({ scheduled: true });
  });

  it("recognises every room format in the schedule", () => {
    const room = (q: string) => {
      const h = search.search(q).find((x) => x.kind === "room");
      return h?.kind === "room" ? `${codeOf(h.building)} ${h.room}${h.scheduled ? "" : " (unlisted)"}` : "none";
    };
    // Letters inside the number, hyphens, leading zeros, short and named rooms.
    expect(room("OTRSN 1E106")).toBe("OTRSN 1E106");
    expect(room("otrsn 1e106")).toBe("OTRSN 1E106");
    expect(room("BRF2 2A03")).toBe("BRF2 2A03");
    expect(room("MANDE B-104")).toBe("MANDE B-104");
    expect(room("MANDE B104")).toBe("MANDE B-104");
    expect(room("mande b 104")).toBe("MANDE B-104");
    expect(room("APM B402A")).toBe("APM B402A");
    expect(room("apmb402a")).toBe("APM B402A");
    expect(room("COA B17")).toBe("COA B17");
    expect(room("GH 15")).toBe("GH 15");
    expect(room("LEDDN AUD")).toBe("LEDDN AUD");
    expect(room("mandeville auditorium")).toBe("MANDE AUD");
    // Leading zeros either way.
    const rwac = buildings.find((b) => b.aliases.includes("RWAC"))!;
    const zeroRoom = rwac.rooms!.find((r) => r.startsWith("0"))!;
    expect(room(`RWAC ${zeroRoom.replace(/^0+/, "")}`)).toBe(`RWAC ${zeroRoom}`);
  });

  it("reads the words people put around room numbers", () => {
    for (const q of ["WLH room 2001", "WLH rm 2001", "WLH rm. 2001", "WLH #2001", "WLH-2001", "WLH, 2001", "room 2001 warren lecture hall"]) {
      expect(first(q), q).toBe("room Warren Lecture Hall 2001");
    }
  });

  it("finds a room number on its own in every building that has it", () => {
    const hits = search.search("2001").filter((h) => h.kind === "room");
    expect(hits.some((h) => h.kind === "room" && codeOf(h.building) === "WLH")).toBe(true);
    expect(hits.every((h) => h.kind === "room" && h.room === "2001" && h.scheduled)).toBe(true);
    // Numbers aren't fuzzy: "2001" doesn't bring up a building called "200".
    expect(search.search("2001").some((h) => h.kind === "building" && h.building.name === "200")).toBe(false);
  });

  it("still offers an unlisted room number in a known building", () => {
    expect(search.search("CENTR 999")[0]).toMatchObject({ kind: "room", room: "999", scheduled: false });
  });

  it("doesn't read building names as rooms", () => {
    expect(search.search("warren lecture hall").some((h) => h.kind === "room")).toBe(false);
    expect(search.search("price center west").some((h) => h.kind === "room")).toBe(false);
    expect(first("EBU3B")).toBe("building Computer Science & Engineering");
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
