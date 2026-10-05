export type Weekday = "Su" | "M" | "Tu" | "W" | "Th" | "F" | "Sa";

/** Indexed by Date#getDay(). */
export const WEEKDAYS: Weekday[] = ["Su", "M", "Tu", "W", "Th", "F", "Sa"];

export interface ClassMeeting {
  id: string;
  /** e.g. "CSE 12" */
  course: string;
  /** Schedule of Classes section, e.g. "001-001-DI", when added from the schedule. */
  section?: string;
  /** LE, DI, LA, SE…, or "FI"/"MI" for final and midterm exams. */
  type?: string;
  /** Map building id ("" when the schedule's building isn't on the map yet). */
  buildingId: string;
  /** Schedule building code, e.g. "WLH". */
  buildingCode?: string;
  room?: string;
  /** Weekly days; empty for one-off meetings such as exams. */
  days: Weekday[];
  /** One-off meetings only: "YYYY-MM-DD". */
  date?: string;
  /** 24h "HH:MM" local time */
  start: string;
  end?: string;
}

export interface UpcomingClass {
  meeting: ClassMeeting;
  startsAt: Date;
}

/** Aim to reach class this many minutes early. */
export const CLASS_BUFFER_MIN = 2;

/** Still treat a class as "next" for a few minutes after it starts (you're running late). */
const GRACE_MS = 10 * 60 * 1000;

/** Start time of a meeting's next occurrence within the coming week, or null. */
export function nextOccurrence(meeting: ClassMeeting, now: Date = new Date()): Date | null {
  const [h, m] = meeting.start.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (meeting.date) {
    const [y, mo, d] = meeting.date.split("-").map(Number);
    const at = new Date(y, mo - 1, d, h, m);
    const inWindow = at.getTime() >= now.getTime() - GRACE_MS && at.getTime() - now.getTime() <= 7 * 86_400_000;
    return inWindow ? at : null;
  }
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now);
    day.setDate(now.getDate() + offset);
    if (!meeting.days.includes(WEEKDAYS[day.getDay()])) continue;
    day.setHours(h, m, 0, 0);
    if (day.getTime() < now.getTime() - GRACE_MS) continue;
    return day;
  }
  return null;
}

/** When a meeting starts on a given day, or null if it doesn't meet that day. */
export function startOn(meeting: ClassMeeting, day: Date): Date | null {
  const [h, m] = meeting.start.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const meets = meeting.date ? meeting.date === isoDate(day) : meeting.days.includes(WEEKDAYS[day.getDay()]);
  if (!meets) return null;
  const at = new Date(day);
  at.setHours(h, m, 0, 0);
  return at;
}

export interface DayClass {
  meeting: ClassMeeting;
  startsAt: Date;
  /** End time, when the schedule has one. */
  endsAt?: Date;
}

/** Everything on your schedule on a given day (classes and that day's exams), in order. */
export function dayClasses(meetings: ClassMeeting[], day: Date): DayClass[] {
  return meetings
    .flatMap((meeting): DayClass[] => {
      const startsAt = startOn(meeting, day);
      if (!startsAt) return [];
      const end = meeting.end ? startOn({ ...meeting, start: meeting.end }, day) : null;
      return [{ meeting, startsAt, ...(end ? { endsAt: end } : {}) }];
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.meeting.course.localeCompare(b.meeting.course));
}

/** "YYYY-MM-DD" in local time. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The next class (or exam) to get to, looking up to a week ahead. */
export function nextClass(meetings: ClassMeeting[], now: Date = new Date()): UpcomingClass | null {
  let best: UpcomingClass | null = null;
  for (const meeting of meetings) {
    const startsAt = nextOccurrence(meeting, now);
    if (startsAt && (!best || startsAt < best.startsAt)) best = { meeting, startsAt };
  }
  return best;
}

/** "M", "TuTh", "MWF" -> ["M"], ["Tu", "Th"], ["M", "W", "F"]. */
export function parseDays(s: string): Weekday[] {
  return (s.match(/Su|Sa|Tu|Th|M|W|F/g) ?? []) as Weekday[];
}

export const MEETING_TYPES: Record<string, string> = {
  LE: "Lecture",
  DI: "Discussion",
  LA: "Lab",
  SE: "Seminar",
  ST: "Studio",
  TU: "Tutorial",
  IN: "Independent study",
  FI: "Final exam",
  MI: "Midterm",
};
