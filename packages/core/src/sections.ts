import { parseDays, type ClassMeeting, type Weekday } from "./schedule.ts";

/** Course sections for one term, generated from the Schedule of Classes. */
export interface SectionsData {
  /** e.g. "Fall 2026" */
  term: string;
  courses: CourseSections[];
}

export interface CourseSections {
  /** "CSE 12" */
  code: string;
  title: string;
  /** [section, type, kind, days, date, start, end, building, room] — compact on purpose. */
  meetings: RawMeeting[];
}

/** kind: "C" class, "F" final, "M" midterm. Times "HHMM", date "MM/DD/YYYY" (exams). */
export type RawMeeting = [string, string, "C" | "F" | "M", string, string, string, string, string, string];

export interface SectionMeeting {
  section: string;
  type: string;
  kind: "class" | "final" | "midterm";
  days: Weekday[];
  date?: string;
  start: string;
  end: string;
  building?: string;
  room?: string;
}

/** One thing a student enrolls in: a lecture group plus (optionally) one discussion/lab. */
export interface SectionChoice {
  id: string;
  label: string;
  meetings: SectionMeeting[];
}

export function expandMeeting(m: RawMeeting): SectionMeeting {
  const [section, type, kind, days, date, start, end, building, room] = m;
  const hhmm = (t: string) => `${t.slice(0, 2)}:${t.slice(2)}`;
  const iso = date ? `${date.slice(6)}-${date.slice(0, 2)}-${date.slice(3, 5)}` : undefined;
  return {
    section,
    type: kind === "F" ? "FI" : kind === "M" ? "MI" : type,
    kind: kind === "F" ? "final" : kind === "M" ? "midterm" : "class",
    days: parseDays(days),
    date: iso,
    start: hhmm(start),
    end: hhmm(end),
    building: building || undefined,
    room: room || undefined,
  };
}

/**
 * Group a course's meetings into enrollable choices. UCSD sections are
 * "GGG-SSS-TY": SSS 000 is the shared part of group GGG (lecture, exams) and
 * every other SSS is one discussion/lab you pick alongside it.
 */
export function sectionChoices(course: CourseSections): SectionChoice[] {
  const groups = new Map<string, { common: SectionMeeting[]; subs: Map<string, SectionMeeting[]> }>();
  for (const raw of course.meetings) {
    const m = expandMeeting(raw);
    const [group, sub = "000"] = m.section.split("-");
    if (!groups.has(group)) groups.set(group, { common: [], subs: new Map() });
    const g = groups.get(group)!;
    if (sub === "000") g.common.push(m);
    else (g.subs.get(sub) ?? g.subs.set(sub, []).get(sub)!).push(m);
  }
  const choices: SectionChoice[] = [];
  for (const [group, { common, subs }] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (subs.size === 0) {
      choices.push({ id: group, label: `Section ${group}`, meetings: common });
      continue;
    }
    for (const [sub, own] of [...subs].sort(([a], [b]) => a.localeCompare(b))) {
      choices.push({ id: `${group}-${sub}`, label: `Section ${group}-${sub}`, meetings: [...common, ...own] });
    }
  }
  return choices;
}

/** "CSE-012" -> "CSE 12", "AWP-004B" -> "AWP 4B". */
export function formatCourseCode(code: string): string {
  const [dept, num = ""] = code.split("-");
  return `${dept} ${num.replace(/^0+(?=\d)/, "")}`.trim();
}

/**
 * A course code for comparing, however it's typed: "CSE 5", "cse5", "CSE 005",
 * "cse-005" -> "CSE5"; "math020c" -> "MATH20C". Zeros right after the subject
 * are dropped, so "cse00" is just "CSE" (every CSE course).
 */
export function courseKey(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^([A-Z]+)0+(?=\d|$)/, "$1");
}

/** Find courses by code ("cse 12", "CSE12", "cse012") or title words. */
export function searchCourses(courses: CourseSections[], query: string, limit = 8): CourseSections[] {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return [];
  const compact = courseKey(q);
  const scored: { c: CourseSections; score: number }[] = [];
  for (const c of courses) {
    const codeCompact = courseKey(c.code);
    let score = 0;
    if (codeCompact === compact) score = 100;
    else if (codeCompact.startsWith(compact)) score = 80 - (codeCompact.length - compact.length);
    else if (c.title.toLowerCase().includes(q)) score = 30;
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.code.localeCompare(b.c.code, undefined, { numeric: true }));
  return scored.slice(0, limit).map((s) => s.c);
}

/** Turn a chosen section into schedule meetings, resolving building codes to map buildings. */
export function toClassMeetings(
  course: CourseSections,
  choice: SectionChoice,
  buildingIdForCode: (code: string) => string | undefined,
  newId: () => string,
): ClassMeeting[] {
  return choice.meetings.map((m) => ({
    id: newId(),
    course: course.code,
    section: m.section,
    type: m.type,
    buildingId: (m.building && buildingIdForCode(m.building)) || "",
    buildingCode: m.building,
    room: m.room,
    days: m.kind === "class" ? m.days : [],
    date: m.kind === "class" ? undefined : m.date,
    start: m.start,
    end: m.end,
  }));
}
