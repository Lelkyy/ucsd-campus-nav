import MiniSearch from "minisearch";
import { roomFloor, type FloorGuess } from "./indoor.ts";
import type { ClassMeeting } from "./schedule.ts";
import { courseKey, expandMeeting, type CourseSections, type SectionMeeting } from "./sections.ts";
import type { Building, IndoorData, Place } from "./types.ts";

/** One suggestion in the search box. */
export type SearchHit =
  /** A class on your schedule: where it meets. */
  | { kind: "class"; meeting: ClassMeeting; building: Building }
  /**
   * A course in this term's schedule of classes: one section of it ("001" is a
   * lecture group, "001-002" one of its discussions or labs), at its room.
   * `listing`: shown as the course while you're still typing its code.
   */
  | {
      kind: "course";
      course: CourseSections;
      section: string;
      meeting: SectionMeeting;
      building: Building;
      room?: string;
      listing?: boolean;
    }
  /** A room: "WLH 2001". `scheduled`: classes meet there (it's in the schedule). */
  | { kind: "room"; building: Building; room: string; scheduled: boolean; floor?: FloorGuess }
  | { kind: "building"; building: Building }
  | { kind: "place"; place: Place };

export interface SearchSources {
  buildings: Building[];
  /** Student place names, shuttle stops and saved places. */
  places?: Place[];
  /** This term's courses (when the schedule data is available). */
  courses?: CourseSections[];
  /** For room floors ("it's on the second floor"). */
  indoor?: IndoorData;
}

/**
 * What a full room number looks like once compared (see roomKey): "2001", "115",
 * "B210", "1202A", "1E106" (Otterson), "2A03" (BRF2), "B402A".
 */
const ROOM_NUMBER = /^[A-Z]{0,2}\d{1,4}[A-Z]{0,2}\d{0,3}$/;
/** Words people put around a room number: "WLH room 2001", "rm 115". */
const ROOM_WORDS = new Set(["room", "rm", "rms", "rooms"]);
const SECTION_PART: Record<string, "lecture" | "discussion" | "lab"> = {
  le: "lecture",
  lec: "lecture",
  lecture: "lecture",
  di: "discussion",
  dis: "discussion",
  disc: "discussion",
  discussion: "discussion",
  la: "lab",
  lab: "lab",
};
/** What can follow a course code to pick its sections: "001", "001-002", "sec 002", "lab", "discussion". */
const SECTION_REST = /^(?:sec(?:tion)?)?(\d{3})(\d{3})?$|^(le|lec|lecture|di|dis|disc|discussion|la|lab)$/;

/**
 * The campus search: buildings by name, code ("WLH", "CSE") and nickname, with
 * typos forgiven ("geisle") and partial words ("warr lec"); rooms in any form
 * ("WLH 2001", "wlh2001", "2001 WLH", "warren lecture hall 2001", "WLH 20…" to
 * list rooms); courses ("CSE 11") and your own classes; student place names
 * and stops.
 */
export class CampusSearch {
  private readonly buildings: MiniSearch<IndexedBuilding>;
  private readonly places: MiniSearch<IndexedPlace>;
  private readonly byId: Map<string, Building>;
  private readonly byCode = new Map<string, Building>();
  private readonly placeById: Map<string, Place>;
  private readonly subjects: Set<string>;
  private readonly courseByKey = new Map<string, CourseSections>();
  /** Every room classes meet in, by its comparison key: "2001" -> WLH 2001, HSS 2001… */
  private readonly roomsByKey = new Map<string, { building: Building; room: string }[]>();

  constructor(private readonly sources: SearchSources) {
    this.byId = new Map(sources.buildings.map((b) => [b.id, b]));
    for (const b of sources.buildings) for (const c of codesOf(b)) if (!this.byCode.has(c)) this.byCode.set(c, b);
    // `squashed`: every name with its spaces taken out, so "pricecenter" and "price center" both work.
    this.buildings = new MiniSearch<IndexedBuilding>({
      fields: ["name", "codes", "aliases", "squashed"],
      tokenize,
      processTerm: (t) => normalize(t) || null,
    });
    this.buildings.addAll(
      sources.buildings.map((b) => ({
        id: b.id,
        name: b.name,
        codes: codesOf(b).join(" "),
        aliases: b.aliases.filter((a) => !isCode(a)).join(" ; "),
        squashed: [b.name, ...b.aliases].map(squash).join(" "),
      })),
    );
    const places = sources.places ?? [];
    this.placeById = new Map(places.map((p) => [p.id, p]));
    this.places = new MiniSearch<IndexedPlace>({
      fields: ["name", "aliases", "squashed"],
      tokenize,
      processTerm: (t) => normalize(t) || null,
    });
    this.places.addAll(
      places.map((p) => ({
        id: p.id,
        name: p.name,
        aliases: p.aliases.join(" ; "),
        squashed: [p.name, ...p.aliases].map(squash).join(" "),
      })),
    );
    this.subjects = new Set((sources.courses ?? []).map((c) => c.code.split(" ")[0].toUpperCase()));
    for (const c of sources.courses ?? []) this.courseByKey.set(courseKey(c.code), c);
    for (const building of sources.buildings) {
      for (const room of building.rooms ?? []) {
        const key = roomKey(room);
        this.roomsByKey.set(key, [...(this.roomsByKey.get(key) ?? []), { building, room }]);
      }
    }
  }

  /** Suggestions for what's typed, best first. `classes`: your schedule, matched first. */
  search(query: string, opts: { classes?: ClassMeeting[]; limit?: number } = {}): SearchHit[] {
    const q = query.trim().replace(/\s+/g, " ");
    if (!q) return [];
    const limit = opts.limit ?? 10;
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const add = (h: SearchHit) => {
      const k = hitKey(h);
      if (!seen.has(k)) {
        seen.add(k);
        hits.push(h);
      }
    };

    // Your classes, then this term's courses and their sections, when it looks like a course ("CSE 11", "cse11 002").
    for (const h of this.classHits(q, opts.classes ?? [])) add(h);
    const course = this.parseCourse(q);
    const courseLike = !!course;
    if (course) for (const h of this.courseHits(q, course)) add(h);

    // Rooms: a building plus a room number, in either order, with or without a space.
    // Not for a course code ("CSE 11" is a course, not room 11 in the CSE building).
    if (!course || !("course" in course)) for (const h of this.roomHits(q)) add(h);

    // Buildings and places by name, code or nickname; a course by its title
    // ("data structures") goes ahead of buildings only if none really match.
    const titleHits = courseLike ? [] : this.titleHits(q).slice(0, 2);
    const strongBuilding = this.buildings.search(q, { ...searchOptions(q), fuzzy: false }).length > 0;
    if (!strongBuilding) for (const h of titleHits) add(h);
    // Your saved places and student names rank above stops with similar names.
    const boostDocument = (id: string) => ({ saved: 1.5, lingo: 1.3, stop: 1 })[this.placeById.get(id)!.kind];
    const placeHits = merge(
      this.places.search(q, { ...searchOptions(q), boostDocument }),
      this.places.search(squash(q), { ...searchOptions(squash(q)), fields: ["squashed"], boostDocument }),
    ).slice(0, 6);
    if (!placeHits.length && q.includes(" "))
      placeHits.push(...this.places.search(q, { ...searchOptions(q), combineWith: "OR", boostDocument }).slice(0, 3));
    const exactPlace = placeHits.filter((r) => {
      const p = this.placeById.get(r.id)!;
      return [p.name, ...p.aliases].some((n) => normalize(n) === normalize(q));
    });
    for (const r of exactPlace) add({ kind: "place", place: this.placeById.get(r.id)! });
    const [topBuilding, ...moreBuildings] = this.findBuildings(q, 8);
    if (topBuilding) add({ kind: "building", building: topBuilding });
    // Names students use ("Revelle bus stop") and your saved places, then the other buildings and stops.
    for (const r of placeHits) if (this.placeById.get(r.id)!.kind !== "stop") add({ kind: "place", place: this.placeById.get(r.id)! });
    for (const b of moreBuildings) add({ kind: "building", building: b });
    for (const r of placeHits) add({ kind: "place", place: this.placeById.get(r.id)! });
    for (const h of titleHits) add(h);
    return hits.slice(0, limit);
  }

  /** Buildings for some text, best first: exact codes, then names (typos forgiven). */
  findBuildings(text: string, limit = 8): Building[] {
    const q = text.trim();
    if (!q) return [];
    const exact = this.byCode.get(q.toUpperCase().replace(/\s+/g, ""));
    const boost = { codes: 4, name: 2, aliases: 1 };
    // Word by word, and with the spaces taken out ("pricecenter", "geisel library", "g eisel").
    let results = merge(
      this.buildings.search(q, { ...searchOptions(q), boost }),
      this.buildings.search(squash(q), { ...searchOptions(squash(q)), fields: ["squashed"] }),
    );
    // Not every word matched anything together: take the best partial matches.
    if (!results.length) results = this.buildings.search(q, { ...searchOptions(q), combineWith: "OR", boost });
    const found = results.map((r) => this.byId.get(r.id)!).filter((b) => b !== exact);
    return [...(exact ? [exact] : []), ...found].slice(0, limit);
  }

  /**
   * Rooms in what's typed. The building can come before or after the room, with
   * or without a space ("WLH 2001", "2001 WLH", "wlh2001", "WLH rm 2001",
   * "warren lecture hall #2001"); rooms are compared loosely ("B104" = "B-104",
   * "103" = "0103") against the rooms classes actually meet in; named rooms
   * match by their start ("Mandeville auditorium" -> MANDE AUD); a number alone
   * ("2001") lists every building with that room; and part of a number lists
   * the rooms it could be ("WLH 20" -> 2001, 2005…).
   */
  private roomHits(q: string): SearchHit[] {
    const words = q
      .replace(/[#,;:]/g, " ")
      // "WLH-2001" is a building and a room; "B-104" is one room.
      .replace(/([a-z]{2,})-(?=\d)/gi, "$1 ")
      .split(/\s+/)
      .filter((w) => w && !ROOM_WORDS.has(w.toLowerCase().replace(/\.$/, "")));
    if (!words.length) return [];

    // Ways to read it as (building, room).
    const readings: { place: string; room: string; code?: Building }[] = [];
    if (words.length === 1) {
      const t = words[0];
      // No space: a building code then the room ("wlh2001", "apmb402a", "ebu3b1124").
      for (let i = 2; i < t.length; i++) {
        const code = this.byCode.get(t.slice(0, i).toUpperCase());
        if (code && /\d/.test(t.slice(i))) readings.push({ place: t.slice(0, i), room: t.slice(i), code });
      }
      // A whole name run together with the room: "warrenlecturehall2001".
      const named = t.match(/^([a-z][a-z0-9]*?[a-z]{3,})((?:b-?)?\d{1,4}[a-z]?\d{0,3})$/i);
      if (!readings.length && named) readings.push({ place: named[1], room: named[2] });
    } else {
      readings.push({ place: words.slice(0, -1).join(" "), room: words[words.length - 1] });
      readings.push({ place: words.slice(1).join(" "), room: words[0] });
      // A room typed with a space inside: "MANDE B 104".
      if (words.length > 2) readings.push({ place: words.slice(0, -2).join(" "), room: words.slice(-2).join("") });
    }

    const out: SearchHit[] = [];
    for (const { place, room, code } of readings) {
      const key = roomKey(room);
      const number = /\d/.test(key) && ROOM_NUMBER.test(key);
      const named = /^[A-Z]{3,}$/.test(key);
      // Still typing: "WLH 2", "CENTR 11", "CSE B".
      const partial = /^(?:\d{1,2}|[A-Z]\d{0,2})$/.test(key);
      if (!number && !named && !partial) continue;
      const buildings = code ? [code] : this.findBuildings(place, 3);
      buildings.forEach((b, rank) => {
        const rooms = b.rooms ?? [];
        const exact = rooms.filter((r) => roomKey(r) === key);
        const starting = rooms.filter((r) => roomKey(r).startsWith(key) && roomKey(r) !== key);
        // Named rooms by their start, either way round: "aud" or "auditorium" -> AUD.
        const byName = named
          ? rooms.filter((r) => /^[A-Z]{3,}$/.test(roomKey(r)) && (roomKey(r).startsWith(key) || key.startsWith(roomKey(r))))
          : [];
        for (const r of [...exact, ...byName]) out.push(this.roomHit(b, r, true));
        if (rank === 0 && !exact.length) for (const r of starting.slice(0, 6)) out.push(this.roomHit(b, r, true));
        // A full room number no class meets in is still a room you can go to.
        if (rank === 0 && number && key.length >= 3 && !exact.length && !starting.length)
          out.push(this.roomHit(b, room.toUpperCase(), false));
      });
    }

    // Just a room number: every building that has it ("2001" -> WLH 2001, HSS 2001…).
    if (words.length === 1 && /\d/.test(words[0])) {
      const key = roomKey(words[0]);
      for (const { building, room } of (this.roomsByKey.get(key) ?? []).slice(0, 8)) out.push(this.roomHit(building, room, true));
    }
    // A known room first: "CENTR 115" is a classroom, "Center Hall Annex 115" probably isn't.
    return out.sort((a, b) => Number((b as { scheduled: boolean }).scheduled) - Number((a as { scheduled: boolean }).scheduled));
  }

  private roomHit(building: Building, room: string, scheduled: boolean): SearchHit {
    return { kind: "room", building, room, scheduled, floor: this.floorOf(building, room) };
  }

  /** Which floor a room is on, as far as anyone knows. */
  floorOf(building: Building, room: string): FloorGuess | undefined {
    return roomFloor(this.sources.indoor?.[building.id], room);
  }

  private classHits(q: string, classes: ClassMeeting[]): SearchHit[] {
    const want = courseKey(q);
    if (want.length < 2) return [];
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    for (const m of classes) {
      const b = this.byId.get(m.buildingId);
      if (!b || !courseKey(m.course).startsWith(want) || m.date) continue;
      const key = `${m.course}|${m.buildingId}|${m.room ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "class", meeting: m, building: b });
    }
    return out.slice(0, 4);
  }

  /**
   * Reads a course code, spaces and leading zeros optional, and what follows it:
   * "cse11", "CSE 011", "cse11 002" (lecture group 002), "cse 11 001-002" (that
   * discussion), "cse11 lab". Not a known course yet ("cse1") gives the code typed
   * so far, to list the courses it could be.
   */
  private parseCourse(
    q: string,
  ): { course: CourseSections; group?: string; sub?: string; part?: "lecture" | "discussion" | "lab" } | { prefix: string } | null {
    const s = q.toLowerCase().replace(/[^a-z0-9]/g, "");
    const subject = s.match(/^[a-z]+/)?.[0] ?? "";
    if (!this.subjects.has(subject.toUpperCase()) || s.length === subject.length || !/\d/.test(s[subject.length])) return null;
    // The longest course code the text starts with, as long as what's left reads as a section.
    for (let i = s.length; i > subject.length; i--) {
      const course = this.courseByKey.get(courseKey(s.slice(0, i)));
      const rest = s.slice(i).match(SECTION_REST);
      if (!course || (i < s.length && !rest)) continue;
      return { course, group: rest?.[1], sub: rest?.[2], part: rest?.[3] ? SECTION_PART[rest[3]] : undefined };
    }
    return { prefix: courseKey(s) };
  }

  /** A course's sections: each lecture group, and each discussion or lab, where it meets. */
  private sections(course: CourseSections): { section: string; group: string; meeting: SectionMeeting; lecture: boolean }[] {
    const out: { section: string; group: string; meeting: SectionMeeting; lecture: boolean }[] = [];
    const seen = new Set<string>();
    for (const m of course.meetings.map(expandMeeting)) {
      if (m.kind !== "class") continue;
      const [group, sub = "000"] = m.section.split("-");
      const section = sub === "000" ? group : `${group}-${sub}`;
      if (seen.has(section)) continue;
      seen.add(section);
      out.push({ section, group, meeting: m, lecture: sub === "000" });
    }
    return out;
  }

  private sectionHit(course: CourseSections, s: { section: string; meeting: SectionMeeting }, listing = false): SearchHit | null {
    const b = s.meeting.building ? this.byCode.get(s.meeting.building.toUpperCase()) : undefined;
    return b ? { kind: "course", course, section: s.section, meeting: s.meeting, building: b, room: s.meeting.room, listing } : null;
  }

  /**
   * A course's sections for what's typed: every lecture group ("CSE 11" ->
   * 001 on TuTh at GH 242, 002 on MW at CENTR 115), plus the discussions when
   * there's only one lecture; one group and its discussions ("cse11 002"); one
   * discussion ("cse11 001-002"); all discussions or labs ("cse11 lab"). A code
   * still being typed ("cse1") lists the courses it could be.
   */
  private courseHits(q: string, parsed: NonNullable<ReturnType<CampusSearch["parseCourse"]>>): SearchHit[] {
    const keep = (h: SearchHit | null): h is SearchHit => !!h;
    if ("prefix" in parsed) {
      const want = parsed.prefix;
      // A zero-padded number ("cse008") is complete: CSE 8A, not CSE 80-something.
      const padded = /^[a-z]+[\s-]*0\d{2}$/i.test(q.trim());
      return (this.sources.courses ?? [])
        .filter((c) => {
          const code = courseKey(c.code);
          return code.startsWith(want) && (!padded || /^[A-Z]/.test(code.slice(want.length)));
        })
        .sort((a, b) => courseKey(a.code).length - courseKey(b.code).length || a.code.localeCompare(b.code, undefined, { numeric: true }))
        .slice(0, 5)
        .map((c) => this.courseListing(c))
        .filter(keep);
    }
    const { course, group, sub, part } = parsed;
    const all = this.sections(course);
    const lectures = all.filter((x) => x.lecture);
    const others = all.filter((x) => !x.lecture);
    let picked: typeof all;
    if (group && sub) picked = all.filter((x) => x.section === `${group}-${sub}` || x.section === group);
    else if (group) picked = all.filter((x) => x.group === group);
    else if (part === "lab") picked = others.filter((x) => x.meeting.type === "LA");
    else if (part === "discussion") picked = others.filter((x) => x.meeting.type !== "LA");
    else if (part === "lecture") picked = lectures;
    else picked = lectures.length > 1 ? lectures : [...lectures, ...others];
    return picked
      .map((x) => this.sectionHit(course, x))
      .filter(keep)
      .slice(0, 8);
  }

  /** Courses by title ("data structures", "calculus"), at their first lecture. */
  private titleHits(q: string): SearchHit[] {
    const words = normalize(q).split(" ").filter(Boolean);
    // Enough typed to mean a title ("calculus", not "data").
    if (words.join("").length < 6) return [];
    return (this.sources.courses ?? [])
      .filter((c) => {
        const title = normalize(c.title).split(" ");
        return words.every((w) => title.some((t) => t.startsWith(w)));
      })
      .slice(0, 4)
      .map((c) => this.courseListing(c))
      .filter((h): h is SearchHit => !!h);
  }

  /** A course as one suggestion, at its first lecture (or first section with a room). */
  private courseListing(c: CourseSections): SearchHit | null {
    const sections = this.sections(c);
    const first = sections.find((x) => x.lecture && x.meeting.building) ?? sections.find((x) => x.meeting.building);
    return first ? this.sectionHit(c, first, true) : null;
  }
}

interface IndexedBuilding {
  id: string;
  name: string;
  codes: string;
  aliases: string;
  squashed: string;
}
interface IndexedPlace {
  id: string;
  name: string;
  aliases: string;
  squashed: string;
}

/** Results of two searches, each document once at its better score, best first. */
function merge<T extends { id: string; score: number }>(a: T[], b: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of [...a, ...b]) if (!best.has(r.id) || best.get(r.id)!.score < r.score) best.set(r.id, r);
  return [...best.values()].sort((x, y) => y.score - x.score);
}

/** A name with its spaces and punctuation taken out: "Price Center" -> "pricecenter". */
function squash(s: string): string {
  return normalize(s).replace(/ /g, "");
}

function searchOptions(q: string) {
  return {
    prefix: true,
    // Forgive a typo in a 4–5 letter word and two in longer ones ("giesel" -> Geisel),
    // but none in short words, codes or numbers ("2001" isn't "200").
    fuzzy: (term: string) => (/\d/.test(term) ? false : term.length >= 6 ? 2 : term.length >= 4 ? 1 : false),
    // Every word should match ("warren lec" -> Warren Lecture Hall); callers fall back to any word.
    combineWith: q.includes(" ") ? ("AND" as const) : ("OR" as const),
  };
}

/** A room for comparing: "B-104" -> "B104", "0103" -> "103", "1e106" -> "1E106". */
function roomKey(room: string): string {
  return room
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/(^|[A-Z])0+(?=\d)/g, "$1");
}

function hitKey(h: SearchHit): string {
  switch (h.kind) {
    case "class":
      return `class:${h.building.id}:${h.meeting.room ?? ""}:${h.meeting.course}`;
    case "course":
      return `course:${h.course.code}:${h.section}`;
    case "room":
      return `room:${h.building.id}:${h.room.toUpperCase()}`;
    case "building":
      return `building:${h.building.id}`;
    case "place":
      return `place:${h.place.id}`;
  }
}

/** Building codes like "WLH", "CENTR", "EBU3B", "CSE". */
function codesOf(b: Building): string[] {
  return b.aliases.filter(isCode);
}

function isCode(a: string): boolean {
  return /^[A-Z][A-Z0-9-]{1,5}$/.test(a);
}

function tokenize(text: string): string[] {
  return text.split(/[\s;,/()&-]+/).filter(Boolean);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
