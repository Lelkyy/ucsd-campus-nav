import {
  MEETING_TYPES,
  WEEKDAYS,
  nextClass,
  searchCourses,
  sectionChoices,
  toClassMeetings,
  type ClassMeeting,
  type CourseSections,
  type Route,
  type SectionChoice,
  type SectionMeeting,
  type Weekday,
} from "@campus/core";
import { useMemo, useRef, useState } from "react";
import { BuildingSearch } from "./BuildingSearch.tsx";
import { DayView, type DirectionsOptions } from "./DayView.tsx";
import type { DayOverlay } from "./MapView.tsx";
import type { CampusData } from "./data.ts";
import type { Schedule } from "./useSchedule.ts";

export type ScheduleView = "day" | "list" | "week";

interface Props {
  data: CampusData;
  schedule: Schedule;
  view: ScheduleView;
  onView: (v: ScheduleView) => void;
  estimateBetween: (fromBuildingId: string, toBuildingId: string, arriveBy: Date) => Route | null;
  /** Directions to a class: its next meeting, or a given day's, from your location or another class. */
  onDirections: (meeting: ClassMeeting, opts?: DirectionsOptions) => void;
  /** The day view's walks and classes, for the map. */
  onDayOverlay?: (overlay: DayOverlay | null) => void;
}

const SCHOOL_DAYS: Weekday[] = ["M", "Tu", "W", "Th", "F"];
const COURSE_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

type Adding = null | "course" | "custom";

/** Color for a course, stable for a given schedule. */
export function courseColor(meetings: ClassMeeting[], course: string): string {
  const courses = [...new Set(meetings.map((m) => m.course))].sort();
  return COURSE_COLORS[Math.max(0, courses.indexOf(course)) % COURSE_COLORS.length];
}

/** The next class to get to, with when to leave and a Directions button. */
export function NextUp({
  data,
  meetings,
  estimate,
  onDirections,
  onSeeDay,
}: {
  data: CampusData;
  meetings: ClassMeeting[];
  estimate: (buildingId: string, startsAt: Date) => Route | null;
  onDirections: (meeting: ClassMeeting) => void;
  /** Open the whole day's timetable. */
  onSeeDay?: () => void;
}) {
  // Only meetings with a place on the map are something to walk or ride to.
  const next = nextClass(meetings.filter((m) => m.buildingId));
  const nextKey = next ? `${next.meeting.id}@${next.startsAt.getTime()}` : "";
  // Re-plan only when the class or the inputs to `estimate` change.
  const trip = useMemo(() => (next ? estimate(next.meeting.buildingId, next.startsAt) : null), [nextKey, estimate]);
  if (!next) return null;
  const now = new Date();
  const late = trip && trip.leaveAt < now;
  return (
    <div className="next-up-wrap">
      <button
        className="next-up"
        style={{
          ["--course" as string]: courseColor(meetings, next.meeting.course),
        }}
        onClick={() => onDirections(next.meeting)}
      >
        <span className="next-up-label">Next class</span>
        <span className="next-up-title">
          {next.meeting.course} <span className="muted">{typeLabel(next.meeting.type)}</span>
        </span>
        <span className="next-up-meta">
          {formatWhen(next.startsAt, now)} · {placeLabel(next.meeting, data)}
        </span>
        <span className={`next-up-leave ${late ? "late" : ""}`}>
          {trip
            ? `${late ? "Leave now" : `Leave by ${formatClock(trip.leaveAt)}`} · ${Math.ceil(trip.minutes)} min`
            : "Set a start to see when to leave"}
        </span>
      </button>
      {onSeeDay && (
        <button className="link next-up-day" onClick={onSeeDay}>
          Your whole day ›
        </button>
      )}
    </div>
  );
}

/** The student's schedule: the day's timetable, the week grid, or the course list to edit. */
const NO_PLACES = new Map<string, never>();

export function SchedulePanel({ data, schedule, view, onView, estimateBetween, onDirections, onDayOverlay }: Props) {
  const { meetings } = schedule;
  const [adding, setAdding] = useState<Adding>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const courses = useMemo(() => [...new Set(meetings.map((m) => m.course))].sort(), [meetings]);
  const colorOf = (course: string) => courseColor(meetings, course);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          My schedule
          {data.sections && <span className="muted small"> · {data.sections.term}</span>}
        </h2>
        <div className="segmented small-seg" role="radiogroup" aria-label="Schedule view">
          {(["day", "week", "list"] as const).map((v) => (
            <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => onView(v)}>
              {v === "day" ? "Day" : v === "week" ? "Week" : "Courses"}
            </button>
          ))}
        </div>
      </div>

      {meetings.length === 0 && !adding && (
        <p className="muted small">
          {data.sections
            ? "Add your courses: pick a section and its lectures, discussions and exams are filled in for you."
            : "Add your classes with their building, room and times."}
        </p>
      )}

      {view === "day" && meetings.length > 0 ? (
        <DayView
          data={data}
          meetings={meetings}
          colorOf={colorOf}
          estimateBetween={estimateBetween}
          onDirections={onDirections}
          onOverlay={onDayOverlay}
        />
      ) : view === "week" ? (
        <WeekView meetings={meetings} colorOf={colorOf} onPick={(m) => onDirections(m)} />
      ) : (
        <ul className="course-list">
          {courses.map((course) => (
            <li key={course} className="course" style={{ ["--course" as string]: colorOf(course) }}>
              <div className="course-head">
                <strong>{course}</strong>
                <button className="link danger" onClick={() => schedule.removeCourse(course)}>
                  Remove
                </button>
              </div>
              <ul className="meeting-list">
                {sortMeetings(meetings.filter((m) => m.course === course)).map((m) =>
                  editingId === m.id ? (
                    <li key={m.id}>
                      <MeetingForm
                        data={data}
                        initial={m}
                        submitLabel="Save"
                        onCancel={() => setEditingId(null)}
                        onSubmit={(patch) => {
                          schedule.update(m.id, patch);
                          setEditingId(null);
                        }}
                      />
                    </li>
                  ) : (
                    <li key={m.id} className="meeting">
                      <span className="type-badge">{m.type ?? "—"}</span>
                      <span className="meeting-main">
                        <span>{whenLabel(m)}</span>
                        <span className={m.buildingId ? "muted" : "warn"}>{placeLabel(m, data)}</span>
                      </span>
                      <span className="row-actions">
                        <button className="link" disabled={!m.buildingId} onClick={() => onDirections(m)}>
                          Go
                        </button>
                        <button className="link" onClick={() => setEditingId(m.id)}>
                          Edit
                        </button>
                        <button
                          className="icon-btn"
                          aria-label={`Delete ${m.course} ${m.type ?? ""}`}
                          onClick={() => schedule.remove(m.id)}
                        >
                          ×
                        </button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {adding === "course" && data.sections && (
        <CourseAdder
          data={data}
          existing={meetings}
          onCancel={() => setAdding(null)}
          onAdd={(course, ms) => {
            schedule.removeCourse(course.code);
            schedule.add(ms);
            setAdding(null);
            setMessage(`Added ${course.code} (${ms.length} meetings).`);
          }}
        />
      )}
      {adding === "custom" && (
        <MeetingForm
          data={data}
          submitLabel="Add"
          onCancel={() => setAdding(null)}
          onSubmit={(m) => {
            schedule.add([{ id: crypto.randomUUID(), ...m }]);
            setAdding(null);
          }}
        />
      )}

      {!adding && (
        <div className="form-row wrap">
          {data.sections && (
            <button className="primary" onClick={() => setAdding("course")}>
              + Add course
            </button>
          )}
          <button onClick={() => setAdding("custom")}>{data.sections ? "+ Custom event" : "+ Add class"}</button>
          <button onClick={schedule.exportFile} disabled={meetings.length === 0}>
            Export
          </button>
          <button onClick={() => fileInput.current?.click()}>Import</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                setMessage(`Imported ${await schedule.importFile(file)} meetings.`);
              } catch (err) {
                setMessage((err as Error).message);
              }
            }}
          />
        </div>
      )}
      {message && <p className="muted small">{message}</p>}
      {meetings.length > 0 && <p className="muted small">Saved in this browser automatically.</p>}
    </section>
  );
}

/** Search the term's courses, pick a section, preview it, add it. */
function CourseAdder({
  data,
  existing,
  onAdd,
  onCancel,
}: {
  data: CampusData;
  existing: ClassMeeting[];
  onAdd: (course: CourseSections, meetings: ClassMeeting[]) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [course, setCourse] = useState<CourseSections | null>(null);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const results = useMemo(() => (course ? [] : searchCourses(data.sections!.courses, query)), [data.sections, query, course]);
  const choices = useMemo(() => (course ? sectionChoices(course) : []), [course]);
  const choice = choices.find((c) => c.id === choiceId) ?? (choices.length === 1 ? choices[0] : null);
  const replacing = course && existing.some((m) => m.course === course.code);

  const buildingIdForCode = (code: string) => data.buildingByCode.get(code)?.id;
  const clashes = choice
    ? findClashes(
        choice,
        existing.filter((m) => m.course !== course?.code),
      )
    : [];

  return (
    <div className="adder">
      {!course ? (
        <>
          <label>
            Course
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="CSE 12, MATH 20C, or a title" />
          </label>
          {results.length > 0 && (
            <ul className="pick-list">
              {results.map((c) => (
                <li key={c.code}>
                  <button className="pick" onClick={() => setCourse(c)}>
                    <strong>{c.code}</strong> <span className="muted">{c.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query && results.length === 0 && <p className="muted small">No course with scheduled meetings matches.</p>}
        </>
      ) : (
        <>
          <div className="course-head">
            <span>
              <strong>{course.code}</strong> <span className="muted">{course.title}</span>
            </span>
            <button className="link" onClick={() => (setCourse(null), setChoiceId(null))}>
              Change
            </button>
          </div>
          {choices.length > 1 && <p className="muted small">Pick your section ({choices.length}):</p>}
          <ul className="pick-list choices">
            {choices.map((c) => (
              <li key={c.id}>
                <label className={`choice ${choice?.id === c.id ? "on" : ""}`}>
                  <input type="radio" name="section" checked={choice?.id === c.id} onChange={() => setChoiceId(c.id)} />
                  <span>
                    <strong>{c.label}</strong>
                    {c.meetings
                      .filter((m) => m.kind === "class")
                      .map((m, i) => (
                        <span key={i} className="muted small block">
                          {m.type} {sectionWhen(m)} · {sectionPlace(m, data)}
                        </span>
                      ))}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {choice && choice.meetings.some((m) => m.kind !== "class") && (
            <p className="muted small">
              Exams included:{" "}
              {choice.meetings
                .filter((m) => m.kind !== "class")
                .map((m) => `${m.kind === "final" ? "Final" : "Midterm"} ${sectionWhen(m)}`)
                .join("; ")}
            </p>
          )}
          {clashes.length > 0 && <p className="warn small">Overlaps: {clashes.join(", ")}</p>}
          <div className="form-row">
            <button
              className="primary"
              disabled={!choice}
              onClick={() =>
                onAdd(
                  course,
                  toClassMeetings(course, choice!, buildingIdForCode, () => crypto.randomUUID()),
                )
              }
            >
              {replacing ? "Replace section" : "Add to schedule"}
            </button>
            <button onClick={onCancel}>Cancel</button>
          </div>
        </>
      )}
      {!course && (
        <div className="form-row">
          <button onClick={onCancel}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/** Add or edit one meeting by hand. */
function MeetingForm({
  data,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  data: CampusData;
  initial?: ClassMeeting;
  submitLabel: string;
  onSubmit: (m: Omit<ClassMeeting, "id">) => void;
  onCancel: () => void;
}) {
  const [course, setCourse] = useState(initial?.course ?? "");
  const [type, setType] = useState(initial?.type ?? "LE");
  const [buildingId, setBuildingId] = useState(initial?.buildingId ?? "");
  const [room, setRoom] = useState(initial?.room ?? "");
  const [once, setOnce] = useState(!!initial?.date);
  const [days, setDays] = useState<Weekday[]>(initial?.days ?? []);
  const [date, setDate] = useState(initial?.date ?? "");
  const [start, setStart] = useState(initial?.start ?? "10:00");
  const [end, setEnd] = useState(initial?.end ?? "10:50");
  const building = data.buildingById.get(buildingId);
  const valid = course.trim() && start && (once ? date : days.length > 0);

  return (
    <form
      className="adder"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit({
          course: course.trim(),
          section: initial?.section,
          type,
          buildingId,
          buildingCode: building ? initial?.buildingCode : undefined,
          room: room.trim() || undefined,
          days: once ? [] : WEEKDAYS.filter((d) => days.includes(d)),
          date: once ? date : undefined,
          start,
          end: end || undefined,
        });
      }}
    >
      <div className="form-row">
        <label>
          Course or event
          <input value={course} onChange={(e) => setCourse(e.target.value)} placeholder="CSE 12" autoFocus={!initial} />
        </label>
        <label className="narrow">
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(MEETING_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <BuildingSearch
        label="Building"
        placeholder="CENTR 115, WLH, Peterson…"
        search={data.buildingSearch}
        buildingById={data.buildingById}
        placeById={NO_PLACES}
        value={building ? { kind: "building", building } : null}
        onSelect={(e) => {
          if (e?.kind !== "building") return setBuildingId("");
          setBuildingId(e.building.id);
          if (e.room) setRoom(e.room);
        }}
      />
      <div className="form-row">
        <label>
          Room
          <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="115" />
        </label>
        <label>
          Starts
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          Ends
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} />
        One-time (exam, event)
      </label>
      {once ? (
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      ) : (
        <fieldset className="days">
          <legend>Days</legend>
          {SCHOOL_DAYS.map((d) => (
            <label key={d} className={days.includes(d) ? "on" : ""}>
              <input
                type="checkbox"
                checked={days.includes(d)}
                onChange={() => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]))}
              />
              {d}
            </label>
          ))}
        </fieldset>
      )}
      <div className="form-row">
        <button type="submit" className="primary" disabled={!valid}>
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const DAY_START = 7 * 60;
const DAY_END = 22 * 60;

/** Mon–Fri grid of weekly meetings; tap one for directions. */
function WeekView({
  meetings,
  colorOf,
  onPick,
}: {
  meetings: ClassMeeting[];
  colorOf: (course: string) => string;
  onPick: (m: ClassMeeting) => void;
}) {
  const weekly = meetings.filter((m) => m.days.length > 0);
  const days: Weekday[] = weekly.some((m) => m.days.includes("Sa")) ? [...SCHOOL_DAYS, "Sa"] : SCHOOL_DAYS;
  const hours = Array.from({ length: (DAY_END - DAY_START) / 60 }, (_, i) => DAY_START / 60 + i);
  const pct = (min: number) => `${((min - DAY_START) / (DAY_END - DAY_START)) * 100}%`;
  return (
    <div className="week" style={{ ["--cols" as string]: days.length }}>
      <div className="week-hours">
        {hours.map((h) => (
          <span key={h} style={{ top: pct(h * 60) }}>
            {h % 12 || 12}
            {h < 12 ? "a" : "p"}
          </span>
        ))}
      </div>
      {days.map((d) => (
        <div key={d} className="week-day">
          <div className="week-day-name">{d}</div>
          <div className="week-col">
            {weekly
              .filter((m) => m.days.includes(d))
              .map((m) => {
                const s = minutes(m.start);
                const e = m.end ? minutes(m.end) : s + 50;
                return (
                  <button
                    key={m.id}
                    className="week-block"
                    style={{
                      top: pct(s),
                      height: `calc(${pct(e)} - ${pct(s)})`,
                      ["--course" as string]: colorOf(m.course),
                    }}
                    title={`${m.course} ${m.type ?? ""} ${m.start}${m.end ? `–${m.end}` : ""}`}
                    onClick={() => onPick(m)}
                    disabled={!m.buildingId}
                  >
                    <strong>{m.course}</strong> {m.type}
                    <span>
                      {m.buildingCode ?? ""} {m.room ?? ""}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- helpers

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function sortMeetings(ms: ClassMeeting[]): ClassMeeting[] {
  const order = (m: ClassMeeting) => (m.date ? 1 : 0) * 1e6 + WEEKDAYS.indexOf(m.days[0] ?? "Su") * 1e4 + minutes(m.start);
  return [...ms].sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : order(a) - order(b)));
}

function typeLabel(type?: string): string {
  return type ? (MEETING_TYPES[type] ?? type) : "";
}

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "a" : "p"}`;
}

function whenLabel(m: ClassMeeting): string {
  const time = `${clock(m.start)}${m.end ? `–${clock(m.end)}` : ""}`;
  if (m.date) {
    const d = new Date(`${m.date}T00:00`);
    return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
  }
  return `${m.days.join("")} ${time}`;
}

function placeLabel(m: ClassMeeting, data: CampusData): string {
  const b = data.buildingById.get(m.buildingId);
  if (b) return `${b.name}${m.room ? ` ${m.room}` : ""}`;
  if (m.buildingCode) return `${m.buildingCode} ${m.room ?? ""} (not on the map yet)`;
  return "Online / no location";
}

function sectionWhen(m: SectionMeeting): string {
  const time = `${clock(m.start)}–${clock(m.end)}`;
  if (m.date) {
    const d = new Date(`${m.date}T00:00`);
    return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
  }
  return `${m.days.join("")} ${time}`;
}

function sectionPlace(m: SectionMeeting, data: CampusData): string {
  if (!m.building) return "Online";
  const b = data.buildingByCode.get(m.building);
  return `${b ? m.building : `${m.building} (not on map)`} ${m.room ?? ""}`.trim();
}

/** Existing meetings a section would overlap with, as labels. */
function findClashes(choice: SectionChoice, existing: ClassMeeting[]): string[] {
  const out = new Set<string>();
  for (const m of choice.meetings) {
    const s = minutes(m.start);
    const e = minutes(m.end);
    for (const x of existing) {
      const xs = minutes(x.start);
      const xe = x.end ? minutes(x.end) : xs + 50;
      const sameDay = m.date ? x.date === m.date : m.days.some((d) => x.days.includes(d));
      if (sameDay && s < xe && xs < e) out.add(`${x.course} ${x.type ?? ""}`.trim());
    }
  }
  return [...out];
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatWhen(d: Date, now: Date): string {
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? formatClock(d) : `${d.toLocaleDateString([], { weekday: "short" })} ${formatClock(d)}`;
}
