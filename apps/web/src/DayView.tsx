import {
  CLASS_BUFFER_MIN,
  MEETING_TYPES,
  classEnd,
  dayClasses,
  defaultPick,
  floorPhrase,
  groupOverlaps,
  isoDate,
  roomFloor,
  type ClassMeeting,
  type DayClass,
  type LngLat,
  type Route,
} from "@campus/core";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { storage, type CampusData } from "./data.ts";
import { formatDistance } from "./Itinerary.tsx";
import type { DayOverlay } from "./MapView.tsx";

export interface DirectionsOptions {
  /** The day to go (directions arrive in time for that day's start). */
  date: Date;
  /** Start from this class's room instead of your location. */
  from?: ClassMeeting;
}

interface Props {
  data: CampusData;
  meetings: ClassMeeting[];
  colorOf: (course: string) => string;
  /** How long getting from one building to another takes, arriving by a time. */
  estimateBetween: (fromBuildingId: string, toBuildingId: string, arriveBy: Date) => Route | null;
  onDirections: (meeting: ClassMeeting, opts: DirectionsOptions) => void;
  /** The day's walks and classes, for the map (null when the view closes). */
  onOverlay?: (overlay: DayOverlay | null) => void;
}

/** Which class you chose in each conflict, by day and the classes involved. */
const CHOICES_KEY = "campus-nav:conflict-choices";

/**
 * Your whole day from the timetable: each class in order with where it is
 * (and roughly which floor), how long it takes to get from one to the next and
 * whether the gap is enough, and directions to any of them, from where you
 * are or from the class before. Classes that overlap are shown as a conflict
 * to choose from; the walks (drawn on the map too) follow your choice.
 */
export function DayView({ data, meetings, colorOf, estimateBetween, onDirections, onOverlay }: Props) {
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [choices, setChoices] = useState<Record<string, string>>(() => storage.get(CHOICES_KEY, {}));
  const now = new Date();
  const today = startOfDay(now);
  const classes = useMemo(() => dayClasses(meetings, day), [meetings, day]);
  const groups = useMemo(() => groupOverlaps(classes), [classes]);
  const week = weekOf(day, meetings);

  // The class you're going to in each group: yours if you chose, else an exam or the earliest.
  const picked = groups.map((g) => (g.length === 1 ? g[0] : (g.find((c) => c.meeting.id === choices[choiceKey(day, g)]) ?? defaultPick(g))));
  const pickedKey = picked.map((c) => c.meeting.id).join(",");
  const choose = (g: DayClass[], c: DayClass) => {
    const next = { ...choices, [choiceKey(day, g)]: c.meeting.id };
    setChoices(next);
    storage.set(CHOICES_KEY, next);
  };

  // Travel from each chosen class to the next (re-planned only when the day or choices change).
  const legs = useMemo(
    () =>
      picked.map((c, i) => {
        const prev = picked[i - 1];
        if (!prev || !prev.meeting.buildingId || !c.meeting.buildingId) return null;
        const gapMin = (c.startsAt.getTime() - classEnd(prev).getTime()) / 60_000;
        if (prev.meeting.buildingId === c.meeting.buildingId) return { prev, gapMin, same: true as const };
        const route = estimateBetween(prev.meeting.buildingId, c.meeting.buildingId, new Date(c.startsAt.getTime() - CLASS_BUFFER_MIN * 60_000));
        return { prev, gapMin, same: false as const, route };
      }),
    // `picked` is derived from these; its ids stand in for it.
    [pickedKey, day, estimateBetween],
  );

  // The day on the map: a numbered pin per class you're going to, and the walks between them.
  useEffect(() => {
    if (!onOverlay) return;
    // Classes in the same building share a pin: "1, 4" with a line for each.
    const byBuilding = new Map<string, { lngLat: LngLat; n: string[]; label: string[]; color: string }>();
    picked.forEach((c, i) => {
      const b = data.buildingById.get(c.meeting.buildingId);
      if (!b) return;
      const pin = byBuilding.get(b.id) ?? { lngLat: b.center, n: [], label: [], color: colorOf(c.meeting.course) };
      pin.n.push(String(i + 1));
      pin.label.push(`${c.meeting.course} · ${clock(c.startsAt)}`);
      byBuilding.set(b.id, pin);
    });
    const stops = [...byBuilding.values()].map((p) => ({ ...p, n: p.n.join(", "), label: p.label.join("\n") }));
    const lines = legs.flatMap((l, i) => (l && !l.same && l.route ? [{ coordinates: l.route.coordinates, color: colorOf(picked[i].meeting.course) }] : []));
    onOverlay(stops.length ? { stops, lines } : null);
  }, [legs, onOverlay]);
  useEffect(() => () => onOverlay?.(null), [onOverlay]);

  const shift = (days: number) => setDay((d) => addDays(d, days));
  const isToday = day.getTime() === today.getTime();
  const conflicts = groups.filter((g) => g.length > 1).length;

  const card = (c: DayClass, opts: { primary: boolean; skipped?: boolean; onPick?: () => void; picked?: boolean }) => {
    const m = c.meeting;
    const b = data.buildingById.get(m.buildingId);
    const floor = b && m.room ? roomFloor(data.indoor[b.id], m.room) : undefined;
    const done = classEnd(c) < now;
    const happening = c.startsAt <= now && now < classEnd(c);
    const exam = m.type === "FI" || m.type === "MI";
    return (
      <div
        className={`day-class ${done ? "done" : ""} ${happening ? "now" : ""} ${opts.skipped ? "skipped" : ""} ${opts.onPick ? "pickable" : ""}`}
        style={{ ["--course" as string]: colorOf(m.course) }}
        {...(opts.onPick
          ? { role: "radio", "aria-checked": !!opts.picked, tabIndex: 0, onClick: opts.onPick, onKeyDown: (e: KeyboardEvent) => (e.key === " " || e.key === "Enter") && opts.onPick!() }
          : {})}
      >
        <span className="day-time">
          {clock(c.startsAt)}
          {c.endsAt && <span className="muted"> – {clock(c.endsAt)}</span>}
        </span>
        <span className="day-main">
          <span className="day-course">
            {opts.onPick && <span className={`day-radio ${opts.picked ? "on" : ""}`} aria-hidden="true" />}
            {m.course} <span className="muted">{m.type ? (MEETING_TYPES[m.type] ?? m.type) : ""}</span>
            {happening && <span className="day-badge">Now</span>}
            {exam && <span className="day-badge exam">Exam</span>}
            {opts.skipped && <span className="day-badge skip">Skipping</span>}
          </span>
          <span className="muted small">
            {b ? `${b.name}${m.room ? ` ${m.room}` : ""}` : m.buildingCode ? `${m.buildingCode} ${m.room ?? ""} (not on the map yet)` : "Online / no location"}
            {floor && ` · ${floorPhrase(floor)}`}
          </span>
        </span>
        {b && !opts.skipped && (
          <button
            className={opts.primary ? "primary small-btn" : "small-btn"}
            onClick={(e) => {
              e.stopPropagation();
              onDirections(m, { date: day });
            }}
          >
            Directions
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="day-view">
      <div className="day-nav">
        <button className="icon-btn" aria-label="Previous day" onClick={() => shift(-1)}>
          ‹
        </button>
        <div className="day-title">
          <strong>{dayName(day, today)}</strong>
          <span className="muted small">{day.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
        </div>
        <button className="icon-btn" aria-label="Next day" onClick={() => shift(1)}>
          ›
        </button>
        {!isToday && (
          <button className="link" onClick={() => setDay(today)}>
            Today
          </button>
        )}
      </div>

      <div className="day-chips" role="radiogroup" aria-label="Day of the week">
        {week.map((d) => {
          const on = d.getTime() === day.getTime();
          const dayGroups = groupOverlaps(dayClasses(meetings, d));
          const count = dayGroups.flat().length;
          const clash = dayGroups.some((g) => g.length > 1);
          return (
            <button key={d.getTime()} role="radio" aria-checked={on} className={`day-chip ${on ? "on" : ""}`} onClick={() => setDay(d)}>
              <span>{d.toLocaleDateString([], { weekday: "short" })}</span>
              <span className="day-chip-count">
                {count || "–"}
                {clash && <span className="day-chip-clash" title="Has a conflict"> !</span>}
              </span>
              {d.getTime() === today.getTime() && <span className="day-chip-today" aria-label="today" />}
            </button>
          );
        })}
      </div>

      {conflicts > 0 && (
        <p className="day-conflict-note" role="note">
          {conflicts === 1 ? "Two classes overlap" : `${conflicts} sets of classes overlap`} {isToday ? "today" : "this day"}. Pick which to go to; the
          walks follow your choice.
        </p>
      )}

      {classes.length === 0 ? (
        <p className="muted small day-empty">
          No classes {isToday ? "today" : `on ${day.toLocaleDateString([], { weekday: "long" })}`}.
          {nextClassDay(day, meetings) && (
            <>
              {" "}
              <button className="link" onClick={() => setDay(nextClassDay(day, meetings)!)}>
                Next class day ›
              </button>
            </>
          )}
        </p>
      ) : (
        <ol className="day-list">
          {groups.map((g, gi) => {
            const leg = legs[gi];
            const chosen = picked[gi];
            const b = data.buildingById.get(chosen.meeting.buildingId);
            return (
              <li key={g.map((c) => c.meeting.id).join("+")} className="day-item">
                {leg && (
                  <div className={`day-leg ${!leg.same && leg.route && leg.route.minutes + CLASS_BUFFER_MIN > leg.gapMin ? "tight" : ""}`}>
                    <span className="day-leg-line" aria-hidden="true" />
                    <span className="day-leg-text">
                      {leg.same ? (
                        <>Same building · {gapText(leg.gapMin)}</>
                      ) : leg.route ? (
                        <>
                          {Math.ceil(leg.route.minutes)} min to {b?.name ?? "the next class"} ({formatDistance(leg.route.meters)}) · {gapText(leg.gapMin)}
                          {leg.route.minutes + CLASS_BUFFER_MIN > leg.gapMin && <strong> · tight, leave right away</strong>}
                        </>
                      ) : (
                        <>{gapText(leg.gapMin)}</>
                      )}
                    </span>
                    {!leg.same && b && (
                      <button className="link" onClick={() => onDirections(chosen.meeting, { date: day, from: leg.prev.meeting })}>
                        Directions from {leg.prev.meeting.course}
                      </button>
                    )}
                  </div>
                )}
                {g.length === 1 ? (
                  card(chosen, { primary: gi === 0 || !leg || leg.same })
                ) : (
                  <div className="day-conflict" role="radiogroup" aria-label={`Conflict at ${clock(g[0].startsAt)}: choose a class`}>
                    <div className="day-conflict-head">
                      <strong>Conflict</strong> · {clock(g[0].startsAt)} – {clock(new Date(Math.max(...g.map((c) => classEnd(c).getTime()))))} · choose one
                    </div>
                    {g.map((c) => (
                      <div key={c.meeting.id}>
                        {card(c, { primary: c === chosen, picked: c === chosen, skipped: c !== chosen, onPick: () => choose(g, c) })}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** A conflict's choice is remembered for that day and that set of classes. */
function choiceKey(day: Date, group: DayClass[]): string {
  return `${isoDate(day)}|${group
    .map((c) => c.meeting.id)
    .sort()
    .join("+")}`;
}

function gapText(min: number): string {
  if (min <= 0) return "back to back";
  if (min < 60) return `${Math.round(min)} min between`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h} h${m ? ` ${m} min` : ""} between`;
}

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return startOfDay(x);
}

function dayName(day: Date, today: Date): string {
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return day.toLocaleDateString([], { weekday: "long" });
}

/** Monday to Friday of the day's week, plus the weekend days you have classes on. */
function weekOf(day: Date, meetings: ClassMeeting[]): Date[] {
  const monday = addDays(day, -((day.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter((d) => {
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    return !weekend || dayClasses(meetings, d).length > 0;
  });
}

/** The next day after this one with anything on it, within two weeks. */
function nextClassDay(day: Date, meetings: ClassMeeting[]): Date | null {
  for (let i = 1; i <= 14; i++) {
    const d = addDays(day, i);
    if (dayClasses(meetings, d).length) return d;
  }
  return null;
}
