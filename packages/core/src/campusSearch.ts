import MiniSearch from "minisearch";
import { roomFloor, type FloorGuess } from "./indoor.ts";
import type { ClassMeeting } from "./schedule.ts";
import { expandMeeting, type CourseSections } from "./sections.ts";
import type { Building, IndoorData, Place } from "./types.ts";

/** One suggestion in the search box. */
export type SearchHit =
  /** A class on your schedule: where it meets. */
  | { kind: "class"; meeting: ClassMeeting; building: Building }
  /** A course in this term's schedule of classes, at its lecture's room. */
  | { kind: "course"; course: CourseSections; building: Building; room?: string }
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

/** A room number: "2001", "115", "B210", "E209", "1202A". */
const ROOM = /^(?:b-?)?\d{2,4}[a-z]?$|^[a-z]\d{3,4}[a-z]?$/i;
/** A course code: "CSE 11", "math20c", "MAE 3". */
const COURSE = /^([a-z]{2,5})\s*(\d{1,3}[a-z]{0,2})$/i;

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

  constructor(private readonly sources: SearchSources) {
    this.byId = new Map(sources.buildings.map((b) => [b.id, b]));
    for (const b of sources.buildings) for (const c of codesOf(b)) if (!this.byCode.has(c)) this.byCode.set(c, b);
    this.buildings = new MiniSearch<IndexedBuilding>({
      fields: ["name", "codes", "aliases"],
      tokenize,
      processTerm: (t) => normalize(t) || null,
    });
    this.buildings.addAll(
      sources.buildings.map((b) => ({ id: b.id, name: b.name, codes: codesOf(b).join(" "), aliases: b.aliases.filter((a) => !isCode(a)).join(" ; ") })),
    );
    const places = sources.places ?? [];
    this.placeById = new Map(places.map((p) => [p.id, p]));
    this.places = new MiniSearch<IndexedPlace>({ fields: ["name", "aliases"], tokenize, processTerm: (t) => normalize(t) || null });
    this.places.addAll(places.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases.join(" ; ") })));
    this.subjects = new Set((sources.courses ?? []).map((c) => c.code.split(" ")[0].toUpperCase()));
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

    // Your classes, then this term's courses, when it looks like a course ("CSE 11", "cse11", "data struct…").
    for (const h of this.classHits(q, opts.classes ?? [])) add(h);
    const course = q.match(COURSE);
    const courseLike = !!course && this.subjects.has(course[1].toUpperCase());
    if (courseLike) for (const h of this.courseHits(q)) add(h);

    // Rooms: a building plus a room number, in either order, with or without a space.
    for (const h of this.roomHits(q)) add(h);

    // Buildings and places by name, code or nickname; a course by its title
    // ("data structures") goes ahead of buildings only if none really match.
    const titleHits = courseLike ? [] : this.courseHits(q, true).slice(0, 2);
    const strongBuilding = this.buildings.search(q, { ...searchOptions(q), fuzzy: false }).length > 0;
    if (!strongBuilding) for (const h of titleHits) add(h);
    // Your saved places and student names rank above stops with similar names.
    const boostDocument = (id: string) => ({ saved: 1.5, lingo: 1.3, stop: 1 })[this.placeById.get(id)!.kind];
    const placeHits = this.places.search(q, { ...searchOptions(q), boostDocument }).slice(0, 6);
    if (!placeHits.length && q.includes(" ")) placeHits.push(...this.places.search(q, { ...searchOptions(q), combineWith: "OR", boostDocument }).slice(0, 3));
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
    let results = this.buildings.search(q, { ...searchOptions(q), boost });
    // Not every word matched anything together: take the best partial matches.
    if (!results.length) results = this.buildings.search(q, { ...searchOptions(q), combineWith: "OR", boost });
    const found = results.map((r) => this.byId.get(r.id)!).filter((b) => b !== exact);
    return [...(exact ? [exact] : []), ...found].slice(0, limit);
  }

  private roomHits(q: string): SearchHit[] {
    const split = splitRoom(q);
    if (!split) return [];
    const { place, room, partial } = split;
    const out: SearchHit[] = [];
    for (const b of this.findBuildings(place, partial ? 1 : 3)) {
      const rooms = b.rooms ?? [];
      const want = room.toUpperCase();
      const listed = rooms.find((r) => r.toUpperCase() === want);
      // "WLH 20" -> the rooms classes meet in that start with 20.
      const starting = rooms.filter((r) => r.toUpperCase().startsWith(want) && r.toUpperCase() !== want);
      if (listed) out.push(this.roomHit(b, listed, true));
      if (!listed || partial) for (const r of starting.slice(0, 6)) out.push(this.roomHit(b, r, true));
      // A full room number nobody's class meets in is still a room you can go to.
      if (!listed && !starting.length && !partial && want.replace(/\D/g, "").length >= 3) out.push(this.roomHit(b, want, false));
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
    const want = compact(q);
    if (want.length < 2) return [];
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    for (const m of classes) {
      const b = this.byId.get(m.buildingId);
      if (!b || !compact(m.course).startsWith(want) || m.date) continue;
      const key = `${m.course}|${m.buildingId}|${m.room ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "class", meeting: m, building: b });
    }
    return out.slice(0, 4);
  }

  private courseHits(q: string, titleOnly = false): SearchHit[] {
    const courses = this.sources.courses ?? [];
    if (!courses.length) return [];
    const want = compact(q);
    const words = normalize(q).split(" ").filter(Boolean);
    const scored: { c: CourseSections; score: number }[] = [];
    for (const c of courses) {
      const code = compact(c.code);
      const title = normalize(c.title);
      let score = 0;
      if (!titleOnly && code === want) score = 100;
      else if (!titleOnly && code.startsWith(want) && want.length >= 3) score = 80 - (code.length - want.length);
      // Titles: every word starts a title word, and enough was typed to mean it ("calculus", not "data").
      else if (words.join("").length >= 6 && words.every((w) => title.split(" ").some((t) => t.startsWith(w)))) score = 30;
      if (score) scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score || a.c.code.localeCompare(b.c.code, undefined, { numeric: true }));
    const out: SearchHit[] = [];
    for (const { c } of scored.slice(0, 4)) {
      // Where it's taught: the lecture's room (else any class meeting with a room).
      const meetings = c.meetings.map(expandMeeting).filter((m) => m.kind === "class" && m.building);
      const m = meetings.find((x) => x.type === "LE") ?? meetings[0];
      const b = m?.building ? this.byCode.get(m.building.toUpperCase()) : undefined;
      if (b) out.push({ kind: "course", course: c, building: b, room: m.room });
    }
    return out;
  }
}

interface IndexedBuilding {
  id: string;
  name: string;
  codes: string;
  aliases: string;
}
interface IndexedPlace {
  id: string;
  name: string;
  aliases: string;
}

function searchOptions(q: string) {
  return {
    prefix: true,
    // Forgive a typo in a 4–5 letter word and two in longer ones ("giesel" -> Geisel),
    // but none in short words and codes.
    fuzzy: (term: string) => (term.length >= 6 ? 2 : term.length >= 4 ? 1 : false),
    // Every word should match ("warren lec" -> Warren Lecture Hall); callers fall back to any word.
    combineWith: q.includes(" ") ? ("AND" as const) : ("OR" as const),
  };
}

/** "WLH 2001", "wlh2001", "2001 WLH", "WLH 20" (partial: rooms starting with 20). */
function splitRoom(q: string): { place: string; room: string; partial: boolean } | null {
  const words = q.split(" ");
  if (words.length > 1) {
    const last = words[words.length - 1];
    const first = words[0];
    const rest = words.slice(0, -1).join(" ");
    // Still typing the room: "WLH 2", "CENTR 11", "CSE B".
    if (/^(?:\d{1,2}|b-?\d{0,2})$/i.test(last)) return { place: rest, room: last.replace("-", ""), partial: true };
    if (ROOM.test(last)) return { place: rest, room: last, partial: false };
    if (ROOM.test(first)) return { place: words.slice(1).join(" "), room: first, partial: false };
    return null;
  }
  // No space: letters then the room number ("wlh2001", "centr115").
  const m = q.match(/^([a-z][a-z0-9]*?[a-z])((?:b-?)?\d{3,4}[a-z]?)$/i);
  return m ? { place: m[1], room: m[2], partial: false } : null;
}

function hitKey(h: SearchHit): string {
  switch (h.kind) {
    case "class":
      return `class:${h.building.id}:${h.meeting.room ?? ""}:${h.meeting.course}`;
    case "course":
      return `course:${h.course.code}`;
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

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
