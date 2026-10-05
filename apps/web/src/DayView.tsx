import { CLASS_BUFFER_MIN, MEETING_TYPES, dayClasses, floorPhrase, roomFloor, type ClassMeeting, type DayClass, type Route } from "@campus/core";
import { useMemo, useState } from "react";
import type { CampusData } from "./data.ts";
import { formatDistance } from "./Itinerary.tsx";

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
}

/**
 * Your whole day from the timetable: each class in order with where it is
 * (and roughly which floor), how long it takes to get from one to the next and
 * whether the gap is enough, and directions to any of them, from where you
 * are or from the class before.
 */
export function DayView({ data, meetings, colorOf, estimateBetween, onDirections }: Props) {
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const now = new Date();
  const today = startOfDay(now);
  const classes = useMemo(() => dayClasses(meetings, day), [meetings, day]);
  const week = weekOf(day, meetings);

  // Travel between consecutive classes (re-planned only when the day or schedule changes).
  const legs = useMemo(
    () =>
      classes.map((c, i) => {
        const prev = classes[i - 1];
        if (!prev || !prev.meeting.buildingId || !c.meeting.buildingId) return null;
        const gapMin = (c.startsAt.getTime() - endOf(prev).getTime()) / 60_000;
        if (prev.meeting.buildingId === c.meeting.buildingId) return { prev, gapMin, same: true as const };
        const route = estimateBetween(prev.meeting.buildingId, c.meeting.buildingId, new Date(c.startsAt.getTime() - CLASS_BUFFER_MIN * 60_000));
        return { prev, gapMin, same: false as const, route };
      }),
    [classes, estimateBetween],
  );

  const shift = (days: number) => setDay((d) => addDays(d, days));
  const isToday = day.getTime() === today.getTime();

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
          const count = dayClasses(meetings, d).length;
          return (
            <button key={d.getTime()} role="radio" aria-checked={on} className={`day-chip ${on ? "on" : ""}`} onClick={() => setDay(d)}>
              <span>{d.toLocaleDateString([], { weekday: "short" })}</span>
              <span className="day-chip-count">{count || "–"}</span>
              {d.getTime() === today.getTime() && <span className="day-chip-today" aria-label="today" />}
            </button>
          );
        })}
      </div>

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
          {classes.map((c, i) => {
            const m = c.meeting;
            const b = data.buildingById.get(m.buildingId);
            const floor = b && m.room ? roomFloor(data.indoor[b.id], m.room) : undefined;
            const leg = legs[i];
            const done = endOf(c) < now;
            const happening = c.startsAt <= now && now < endOf(c);
            const exam = m.type === "FI" || m.type === "MI";
            return (
              <li key={`${m.id}`} className="day-item" style={{ ["--course" as string]: colorOf(m.course) }}>
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
                      <button className="link" onClick={() => onDirections(m, { date: day, from: leg.prev.meeting })}>
                        Directions from {leg.prev.meeting.course}
                      </button>
                    )}
                  </div>
                )}
                <div className={`day-class ${done ? "done" : ""} ${happening ? "now" : ""}`}>
                  <span className="day-time">
                    {clock(c.startsAt)}
                    {c.endsAt && <span className="muted"> – {clock(c.endsAt)}</span>}
                  </span>
                  <span className="day-main">
                    <span className="day-course">
                      {m.course} <span className="muted">{m.type ? (MEETING_TYPES[m.type] ?? m.type) : ""}</span>
                      {happening && <span className="day-badge">Now</span>}
                      {exam && <span className="day-badge exam">Exam</span>}
                    </span>
                    <span className="muted small">
                      {b ? `${b.name}${m.room ? ` ${m.room}` : ""}` : m.buildingCode ? `${m.buildingCode} ${m.room ?? ""} (not on the map yet)` : "Online / no location"}
                      {floor && ` · ${floorPhrase(floor)}`}
                    </span>
                  </span>
                  {b && (
                    <button className={i === 0 || !leg || leg.same ? "primary small-btn" : "small-btn"} onClick={() => onDirections(m, { date: day })}>
                      Directions
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function endOf(c: DayClass): Date {
  return c.endsAt ?? new Date(c.startsAt.getTime() + 50 * 60_000);
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
