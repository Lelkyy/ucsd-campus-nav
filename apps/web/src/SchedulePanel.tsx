import {
  MEETING_TYPES,
  WEEKDAYS,
  nextClass,
  searchCourses,
  sectionChoices,
  toClassMeetings,
  type ClassMeeting,
  type CourseSections,
  type LngLat,
  type Route,
  type SectionChoice,
  type SectionMeeting,
  type Weekday,
} from "@campus/core";
import { useMemo, useRef, useState } from "react";
import { COURSE_COLORS } from "./palette.ts";
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
  /** Your saved home, the trips to and from it, and setting it. */
  home?: LngLat | null;
  estimateHome?: (buildingId: string, dir: "to" | "from", at: Date) => Route | null;
  onDirectionsHome?: (meeting: ClassMeeting, leaveAt: Date) => void;
  onSetHome?: () => void;
}

const SCHOOL_DAYS: Weekday[] = ["M", "Tu", "W", "Th", "F"];

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

export function SchedulePanel({
  data,
  schedule,
  view,
  onView,
  estimateBetween,
  onDirections,
  onDayOverlay,
  home,
  estimateHome,
  onDirectionsHome,
  onSetHome,
}: Props) {
  const { meetings } = schedule;
  // null: browsing; "" : adding a new course; a code: changing that course's section.
  const [adding, setAdding] = useState<string | null>(null);
  const [addingCustom, setAddingCustom] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The last course removed, to put back.
  const [removed, setRemoved] = useState<ClassMeeting[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const courses = useMemo(() => [...new Set(meetings.map((m) => m.course))].sort(), [meetings]);
  const colorOf = (course: string) => courseColor(meetings, course);
  const titleOf = (code: string) => data.sections?.courses.find((c) => c.code === code)?.title;
  const busy = adding !== null || addingCustom;

  const removeCourse = (course: string) => {
    setRemoved(meetings.filter((m) => m.course === course));
    setMessage(null);
    schedule.removeCourse(course);
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          My schedule
          {data.sections && <span className="muted small"> · {data.sections.term}</span>}
        </h2>
        {!busy && meetings.length > 0 && (
          <button className="primary small-btn" onClick={() => (data.sections ? setAdding("") : setAddingCustom(true))}>
            + Add course
          </button>
        )}
      </div>

      {adding !== null && data.sections ? (
        <CourseAdder
          data={data}
          existing={meetings}
          initialCourse={adding ? data.sections.courses.find((c) => c.code === adding) : undefined}
          onCancel={() => setAdding(null)}
          onAdd={(course, ms) => {
            schedule.removeCourse(course.code);
            schedule.add(ms);
            setAdding(null);
            setRemoved(null);
            setMessage(`${course.code} is in your schedule.`);
          }}
        />
      ) : addingCustom ? (
        <MeetingForm
          data={data}
          submitLabel="Add"
          onCancel={() => setAddingCustom(false)}
          onSubmit={(m) => {
            schedule.add([{ id: crypto.randomUUID(), ...m }]);
            setAddingCustom(false);
          }}
        />
      ) : meetings.length === 0 ? (
        <div className="schedule-empty">
          <p>
            {data.sections
              ? "Add your courses and pick your sections. Lectures, discussions and exams fill in, with directions to each."
              : "Add your classes with their building, room and times."}
          </p>
          <button className="primary" onClick={() => (data.sections ? setAdding("") : setAddingCustom(true))}>
            {data.sections ? "+ Add your first course" : "+ Add a class"}
          </button>
        </div>
      ) : (
        <>
          <div className="segmented schedule-views" role="radiogroup" aria-label="Schedule view">
            {(["day", "week", "list"] as const).map((v) => (
              <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => onView(v)}>
                {v === "day" ? "Day" : v === "week" ? "Week" : "Courses"}
              </button>
            ))}
          </div>
          {view === "day" ? (
            <DayView
              data={data}
              meetings={meetings}
              colorOf={colorOf}
              estimateBetween={estimateBetween}
              onDirections={onDirections}
              onOverlay={onDayOverlay}
              home={home}
              estimateHome={estimateHome}
              onDirectionsHome={onDirectionsHome}
              onSetHome={onSetHome}
            />
          ) : view === "week" ? (
            <WeekView meetings={meetings} colorOf={colorOf} onPick={(m) => onDirections(m)} />
          ) : (
            <ul className="course-list">
              {courses.map((course) => {
                const own = sortMeetings(meetings.filter((m) => m.course === course));
                // Courses from the catalog are changed by section; hand-made events meeting by meeting.
                const fromCatalog = !!data.sections && own.some((m) => m.section);
                const section = sectionGroup(own);
                return (
                  <li key={course} className="course" style={{ ["--course" as string]: colorOf(course) }}>
                    <div className="course-head">
                      <span className="course-name">
                        <strong>{course}</strong>
                        {section && <span className="muted small"> · Section {section}</span>}
                      </span>
                      <span className="row-actions">
                        {fromCatalog && (
                          <button className="link" onClick={() => setAdding(course)}>
                            Change section
                          </button>
                        )}
                        <button className="link danger" onClick={() => removeCourse(course)}>
                          Remove
                        </button>
                      </span>
                    </div>
                    {titleOf(course) && <div className="muted small">{titleOf(course)}</div>}
                    <ul className="meeting-list">
                      {own.map((m) =>
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
                          <li key={m.id} className="meeting-row">
                            <button
                              className="meeting"
                              disabled={!m.buildingId}
                              title={m.buildingId ? "Directions" : undefined}
                              onClick={() => onDirections(m)}
                            >
                              <span className="meeting-type">{typeLabel(m.type) || "Class"}</span>
                              <span className="meeting-main">
                                <span>{whenLabel(m)}</span>
                                <span className={m.buildingId ? "muted" : "warn"}>{placeLabel(m, data)}</span>
                              </span>
                              {m.buildingId && (
                                <span className="meeting-go" aria-hidden="true">
                                  ›
                                </span>
                              )}
                            </button>
                            {!fromCatalog && (
                              <button className="link" onClick={() => setEditingId(m.id)}>
                                Edit
                              </button>
                            )}
                          </li>
                        ),
                      )}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {removed && !busy && (
        <p className="undo-note small">
          Removed {removed[0]?.course}.{" "}
          <button
            className="link"
            onClick={() => {
              schedule.add(removed);
              setRemoved(null);
            }}
          >
            Undo
          </button>
        </p>
      )}
      {message && !busy && !removed && <p className="muted small">{message}</p>}

      {!busy && (
        <p className="schedule-footer muted small">
          {data.sections && (
            <>
              <button className="link" onClick={() => setAddingCustom(true)}>
                Add a custom event
              </button>
              {" · "}
            </>
          )}
          {meetings.length > 0 && (
            <>
              <button className="link" onClick={schedule.exportFile}>
                Export
              </button>
              {" · "}
            </>
          )}
          <button className="link" onClick={() => fileInput.current?.click()}>
            Import
          </button>
          {meetings.length > 0 && <> · Saved in this browser</>}
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
        </p>
      )}
    </section>
  );
}

/**
 * Search the term's courses, then pick a lecture and, if it has them, one of
 * its discussions or labs: two short lists instead of every combination.
 */
function CourseAdder({
  data,
  existing,
  initialCourse,
  onAdd,
  onCancel,
}: {
  data: CampusData;
  existing: ClassMeeting[];
  /** Changing the section of a course already in the schedule. */
  initialCourse?: CourseSections;
  onAdd: (course: CourseSections, meetings: ClassMeeting[]) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [course, setCourse] = useState<CourseSections | null>(initialCourse ?? null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const results = useMemo(() => (course ? [] : searchCourses(data.sections!.courses, query)), [data.sections, query, course]);
  const groups = useMemo(() => (course ? lectureGroups(sectionChoices(course)) : []), [course]);
  const group = groups.find((g) => g.id === groupId) ?? (groups.length === 1 ? groups[0] : null);
  const choice = group ? (group.choices.find((c) => c.id === choiceId) ?? (group.choices.length === 1 ? group.choices[0] : null)) : null;
  const others = existing.filter((m) => m.course !== course?.code);
  const current = course ? existing.filter((m) => m.course === course.code) : [];

  const buildingIdForCode = (code: string) => data.buildingByCode.get(code)?.id;
  const pickCourse = (c: CourseSections | null) => {
    setCourse(c);
    setGroupId(null);
    setChoiceId(null);
  };
  // The type is left out when the heading already says it ("Lecture 001").
  const lines = (ms: SectionMeeting[], heading?: string) =>
    ms.map((m, i) => (
      <span key={i} className="muted small block">
        {heading?.startsWith(typeLabel(m.type)) ? "" : `${typeLabel(m.type)} · `}
        {sectionWhen(m)} · {sectionPlace(m, data)}
      </span>
    ));
  const clashNote = (ms: SectionMeeting[]) => {
    const clashes = findClashes(ms, others);
    return clashes.length > 0 && <span className="warn small block">Overlaps {clashes.join(", ")}</span>;
  };

  if (!course) {
    return (
      <div className="adder">
        <label>
          Find a course
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="CSE 12, MATH 20C, or a title" />
        </label>
        {results.length > 0 && (
          <ul className="pick-list">
            {results.map((c) => (
              <li key={c.code}>
                <button className="pick" onClick={() => pickCourse(c)}>
                  <strong>{c.code}</strong> <span className="muted">{c.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {query && results.length === 0 && <p className="muted small">No course with scheduled meetings matches.</p>}
        <div className="form-row">
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  const exams = choice?.meetings.filter((m) => m.kind !== "class") ?? [];
  return (
    <div className="adder">
      <div className="course-head">
        <span>
          <strong>{course.code}</strong> <span className="muted">{course.title}</span>
        </span>
        {!initialCourse && (
          <button className="link" onClick={() => pickCourse(null)}>
            Change
          </button>
        )}
      </div>

      {groups.length > 1 && (
        <fieldset className="pick-step">
          <legend>1. Pick a lecture</legend>
          {group ? (
            <div className="choice on picked">
              <span>
                <strong>{group.label}</strong>
                {lines(group.common, group.label)}
              </span>
              <button className="link" onClick={() => (setGroupId(null), setChoiceId(null))}>
                Change
              </button>
            </div>
          ) : (
            <ul className="pick-list choices">
              {groups.map((g) => (
                <li key={g.id}>
                  <button className="choice" onClick={() => (setGroupId(g.id), setChoiceId(null))}>
                    <span>
                      <strong>{g.label}</strong>
                      {current.some((m) => m.section?.startsWith(`${g.id}-`) || m.section === g.id) && (
                        <span className="day-badge">Current</span>
                      )}
                      {lines(g.common, g.label)}
                      {clashNote(g.common)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}

      {group && group.choices.length > 1 && (
        <fieldset className="pick-step">
          <legend>
            {groups.length > 1 ? "2. " : ""}Pick a {subKindLabel(group)}
          </legend>
          <ul className="pick-list choices">
            {group.choices.map((c) => {
              // Just this option's own classes: the lecture and exams come with every one.
              const own = c.meetings.filter((m) => m.kind === "class" && !group.common.includes(m));
              return (
                <li key={c.id}>
                  <button
                    className={`choice ${choice?.id === c.id ? "on" : ""}`}
                    aria-pressed={choice?.id === c.id}
                    onClick={() => setChoiceId(c.id)}
                  >
                    <span>
                      {lines(own, typeLabel(own[0]?.type))}
                      {clashNote(own)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      {choice && (
        <div className="adder-summary small">
          {exams.length > 0 && (
            <span className="muted block">
              Exams:{" "}
              {mergeExams(exams)
                .map((e) => `${e.label} ${e.when} · ${e.places.map((p) => sectionPlace(p, data)).join(" or ")}`)
                .join("; ")}
            </span>
          )}
          {clashNote(choice.meetings)}
        </div>
      )}

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
          {!choice ? "Pick a section" : current.length ? "Switch to this section" : `Add ${course.code}`}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** A lecture group ("001") and the discussions or labs you pick with it. */
interface LectureGroup {
  id: string;
  label: string;
  /** What everyone in the group attends (lecture, exams). */
  common: SectionMeeting[];
  choices: SectionChoice[];
}

function lectureGroups(choices: SectionChoice[]): LectureGroup[] {
  const groups = new Map<string, LectureGroup>();
  for (const c of choices) {
    const id = c.id.split("-")[0];
    let g = groups.get(id);
    if (!g) {
      // Shared meetings: in every choice of the group (all of them when there's one).
      const common = c.meetings.filter((m) => !m.section.includes("-") || m.section.split("-")[1] === "000");
      const classes = common.filter((m) => m.kind === "class");
      const type = typeLabel(classes[0]?.type) || "Section";
      g = { id, label: `${type} ${id}`, common: classes, choices: [] };
      groups.set(id, g);
    }
    g.choices.push(c);
  }
  return [...groups.values()];
}

/** "discussion", "lab" or "section", from what the group's choices are. */
function subKindLabel(g: LectureGroup): string {
  const types = new Set(g.choices.flatMap((c) => c.meetings.filter((m) => m.kind === "class" && !g.common.includes(m)).map((m) => m.type)));
  if (types.size === 1) return (typeLabel([...types][0]) || "section").toLowerCase();
  return "section";
}

/** Exams held in several rooms at once (split by name or section) as one line. */
function mergeExams(exams: SectionMeeting[]): { label: string; when: string; places: SectionMeeting[] }[] {
  const out = new Map<string, { label: string; when: string; places: SectionMeeting[] }>();
  for (const m of exams) {
    const when = sectionWhen(m);
    const key = `${m.type}|${when}`;
    const e = out.get(key) ?? { label: m.kind === "final" ? "Final" : "Midterm", when, places: [] };
    e.places.push(m);
    out.set(key, e);
  }
  return [...out.values()];
}

/** The section a course's meetings came from, as students see it ("002", "A00"). */
function sectionGroup(ms: ClassMeeting[]): string | undefined {
  const sub = ms.find((m) => m.section && m.section.split("-")[1] && m.section.split("-")[1] !== "000")?.section;
  const any = sub ?? ms.find((m) => m.section)?.section;
  if (!any) return undefined;
  const [group, s] = any.split("-");
  return s && s !== "000" ? `${group}-${s}` : group;
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

/** Mon–Fri grid of weekly meetings, overlapping ones side by side; tap one for directions. */
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
  const first = Math.min(DAY_START, ...weekly.map((m) => Math.floor(minutes(m.start) / 60) * 60));
  const last = Math.max(DAY_END, ...weekly.map((m) => Math.ceil(endMinutes(m) / 60) * 60));
  const hours = Array.from({ length: (last - first) / 60 }, (_, i) => first / 60 + i);
  const pct = (min: number) => `${((min - first) / (last - first)) * 100}%`;
  return (
    <div className="week" style={{ ["--cols" as string]: days.length, ["--hours" as string]: hours.length }}>
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
            {lanes(weekly.filter((m) => m.days.includes(d))).map(({ m, lane, of }) => {
              const s = minutes(m.start);
              const e = endMinutes(m);
              return (
                <button
                  key={m.id}
                  className={`week-block ${of > 1 ? "clash" : ""}`}
                  style={{
                    top: pct(s),
                    height: `calc(${pct(e)} - ${pct(s)})`,
                    left: `calc(${(lane / of) * 100}% + 1px)`,
                    width: `calc(${100 / of}% - 2px)`,
                    ["--course" as string]: colorOf(m.course),
                  }}
                  title={`${m.course} ${typeLabel(m.type)} · ${whenLabel(m)}${of > 1 ? " · overlaps another class" : ""}`}
                  onClick={() => onPick(m)}
                  disabled={!m.buildingId}
                >
                  <strong>
                    {m.course}
                    {of === 1 && <small> {m.type}</small>}
                  </strong>
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

/** Side-by-side columns for a day's meetings: each overlapping cluster split evenly. */
function lanes(ms: ClassMeeting[]): { m: ClassMeeting; lane: number; of: number }[] {
  const sorted = [...ms].sort((a, b) => minutes(a.start) - minutes(b.start));
  const out: { m: ClassMeeting; lane: number; of: number }[] = [];
  let cluster: { m: ClassMeeting; lane: number; of: number }[] = [];
  let clusterEnd = -1;
  const close = () => {
    const of = Math.max(0, ...cluster.map((c) => c.lane)) + 1;
    for (const c of cluster) c.of = of;
    out.push(...cluster);
    cluster = [];
  };
  for (const m of sorted) {
    if (minutes(m.start) >= clusterEnd) close();
    // The first lane that's free by this start.
    const busy = new Set(cluster.filter((c) => endMinutes(c.m) > minutes(m.start)).map((c) => c.lane));
    let lane = 0;
    while (busy.has(lane)) lane++;
    cluster.push({ m, lane, of: 1 });
    clusterEnd = Math.max(clusterEnd, endMinutes(m));
  }
  close();
  return out;
}

// --- helpers

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function endMinutes(m: ClassMeeting): number {
  return m.end ? minutes(m.end) : minutes(m.start) + 50;
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
  return `${daysLabel(m.days)} ${time}`;
}

const DAY_SHORT: Record<string, string> = { M: "Mon", Tu: "Tue", W: "Wed", Th: "Thu", F: "Fri", Sa: "Sat", Su: "Sun" };

/** ["Tu", "Th"] -> "Tue/Thu". */
function daysLabel(days: readonly string[]): string {
  return days.map((d) => DAY_SHORT[d] ?? d).join("/");
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
  return `${daysLabel(m.days)} ${time}`;
}

function sectionPlace(m: SectionMeeting, data: CampusData): string {
  if (!m.building) return "Online";
  const b = data.buildingByCode.get(m.building);
  return `${b ? b.name : `${m.building} (not on the map yet)`} ${m.room ?? ""}`.trim();
}

/** Existing meetings these would overlap with, as labels. */
function findClashes(meetings: SectionMeeting[], existing: ClassMeeting[]): string[] {
  const out = new Set<string>();
  for (const m of meetings) {
    const s = minutes(m.start);
    const e = minutes(m.end);
    for (const x of existing) {
      const xs = minutes(x.start);
      const xe = x.end ? minutes(x.end) : xs + 50;
      const sameDay = m.date ? x.date === m.date : m.days.some((d) => x.days.includes(d));
      if (sameDay && s < xe && xs < e) out.add(`${x.course} ${typeLabel(x.type).toLowerCase()}`.trim());
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
