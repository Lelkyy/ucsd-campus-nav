import { floorPlan, levelLabel, levelsOf, type Building, type IndoorRoom, type IndoorRoute, type InsideHints } from "@campus/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon } from "./Icons.tsx";
import { fitProjection } from "./planProjection.ts";

const W = 640;
const PAD = 36;
/** Animation: a short pause at the door, walking speed on screen (m/s), and the pause on the stairs. */
const START_S = 0.6;
const ANIM_MPS = 16;
const CHANGE_S = 1.8;

interface Props {
  building: Building;
  room: string;
  indoorRooms?: IndoorRoom[];
  hints: InsideHints;
  /** The way from the door to the room (only shown when the building is mapped well enough to have one). */
  way: IndoorRoute;
  onClose: () => void;
}

type Phase = { kind: "start" } | { kind: "walk"; leg: number; f: number } | { kind: "change"; leg: number; f: number } | { kind: "end" };

/**
 * A drawing of the inside of a building, to scale and north-up: walls, the
 * mapped rooms and corridors on each floor, and the way from your door to the
 * room. A dot walks the way, switching floors at the stairs or elevator.
 */
export function BuildingView({ building, room, indoorRooms, hints, way, onClose }: Props) {
  const levels = useMemo(
    () =>
      [...new Set([...(indoorRooms ?? []).filter((r) => r.source === "osm" && r.outline).flatMap((r) => levelsOf(r.level)), ...way.legs.map((l) => l.level)])].sort(
        (a, b) => a - b,
      ),
    [indoorRooms, way],
  );
  const roomLevel = way.legs[way.legs.length - 1].level;

  // Timeline: door pause, then each floor's walk, with a floor change between them.
  const timeline = useMemo(() => {
    const parts: { kind: "walk" | "change"; leg: number; from: number; to: number }[] = [];
    let t = START_S;
    way.legs.forEach((l, k) => {
      if (k > 0) parts.push({ kind: "change", leg: k, from: t, to: (t += CHANGE_S) });
      parts.push({ kind: "walk", leg: k, from: t, to: (t += Math.max(0.8, l.meters / ANIM_MPS)) });
    });
    return { parts, total: t };
  }, [way]);
  const reduceMotion = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);
  const [clock, setClock] = useState(reduceMotion ? timeline.total : 0);
  const [playing, setPlaying] = useState(!reduceMotion);
  const [pickedLevel, setPickedLevel] = useState<number | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!playing) return;
    startedAt.current = performance.now() - clock * 1000;
    let frame = requestAnimationFrame(function tick(now) {
      const t = (now - startedAt.current) / 1000;
      setClock(Math.min(t, timeline.total));
      if (t >= timeline.total) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // Restarting only on play/pause; `clock` is read once to resume where it stopped.
  }, [playing, timeline]);

  const phase: Phase = (() => {
    if (clock < START_S) return { kind: "start" };
    const p = timeline.parts.find((x) => clock < x.to);
    if (!p) return { kind: "end" };
    return { kind: p.kind, leg: p.leg, f: (clock - p.from) / (p.to - p.from) };
  })();
  // The floor the animation is on; halfway through a floor change it moves to the next one.
  const animLevel =
    phase.kind === "start"
      ? way.legs[0].level
      : phase.kind === "end"
        ? roomLevel
        : phase.kind === "change" && phase.f < 0.5
          ? way.legs[phase.leg - 1].level
          : way.legs[phase.leg].level;
  const level = pickedLevel ?? animLevel;

  // To scale and north up, framing the walls, the way and the door.
  const outline = building.outline ?? [];
  const door = hints.entrance;
  const proj = fitProjection([...outline.flat(), ...way.legs.flatMap((l) => l.points), ...(door ? [door.lngLat] : [])], W, PAD);
  const { xy, scale, widthM, height: H, ring: ringPath } = proj;
  const linePath = (line: [number, number][]) => line.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");

  const legsXY = way.legs.map((l) => l.points.map(xy));
  /** How far along each leg the dot has got (0–1). */
  const legDone = (k: number) =>
    phase.kind === "end" ? 1 : phase.kind === "start" ? 0 : k < phase.leg ? 1 : k > phase.leg ? 0 : phase.kind === "walk" ? phase.f : 0;
  const dot: [number, number] =
    phase.kind === "start" ? legsXY[0][0] : phase.kind === "end" ? last(last(legsXY)) : phase.kind === "change" ? legsXY[phase.leg][0] : alongLine(legsXY[phase.leg], phase.f);

  const plan = floorPlan(indoorRooms, level);
  const isTarget = (r: IndoorRoom) => level === roomLevel && r.ref?.toUpperCase() === room.toUpperCase();
  const scaleBarM = niceMeters(widthM / 4);

  // Written directions, one per stage of the animation.
  const steps = way.legs.flatMap((l, k) => {
    const next = way.legs[k + 1];
    const meters = `${Math.max(1, Math.round(l.meters))} m`;
    const out: { text: string; stage: number }[] = [];
    if (k === 0) out.push({ text: door ? `Go in at the green door, on ${levelLabel(l.level).toLowerCase()}.` : `Go in where the route ends, on ${levelLabel(l.level).toLowerCase()}.`, stage: -1 });
    if (k > 0) out.push({ text: changeText(l.via, way.legs[k - 1].level, l.level), stage: 2 * k - 1 });
    out.push({ text: next ? `Walk ${meters} to the ${next.via === "elevator" ? "elevator" : "stairs"}.` : `Walk ${meters} to ${room}.`, stage: 2 * k });
    return out;
  });
  const stage = phase.kind === "start" ? -1 : phase.kind === "end" ? Infinity : phase.kind === "change" ? 2 * phase.leg - 1 : 2 * phase.leg;
  const changing =
    phase.kind === "change" ? { from: way.legs[phase.leg - 1].level, to: way.legs[phase.leg].level, via: way.legs[phase.leg].via } : null;

  const replay = () => {
    setPickedLevel(null);
    setClock(0);
    setPlaying(true);
  };

  return (
    <div className="inside-view" role="dialog" aria-label={`Inside ${building.name}`}>
      <div className="inside-view-card">
        <header className="inside-view-head">
          <div>
            <h2>Inside {building.name}</h2>
            <p className="muted small">
              Room {room} · {levelLabel(roomLevel)} · about {Math.round(way.meters)} m from the door
            </p>
          </div>
          <button className="icon-btn" aria-label="Close inside view" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="inside-view-body">
          <div className="floor-tabs" role="radiogroup" aria-label="Floor">
            {[...levels].reverse().map((l) => (
              <button
                key={l}
                role="radio"
                aria-checked={l === level}
                aria-label={levelLabel(l)}
                className={l === level ? "on" : ""}
                onClick={() => {
                  setPlaying(false);
                  setPickedLevel(l);
                }}
              >
                {l < 0 ? "B" : l + 1}
                {way.legs.some((x) => x.level === l) && <span className={`dot ${l === roomLevel ? "room" : ""}`} aria-hidden="true" />}
              </button>
            ))}
          </div>

          <div className="iv-stage">
            {changing && (
              <div className="iv-cue" role="status">
                <span aria-hidden="true">{changing.to > changing.from ? "↑" : "↓"}</span>
                {changeText(changing.via, changing.from, changing.to)}
              </div>
            )}
            <svg viewBox={`0 0 ${W} ${H}`} className="inside-svg" role="img" aria-label={`${building.name}, ${levelLabel(level)}`}>
              <g key={level} className="iv-floor">
                {outline.map((ring, i) => (
                  <path key={i} d={ringPath(ring)} className="iv-footprint" />
                ))}
                {plan.map((r, i) => (
                  <path key={i} d={ringPath(r.outline!)} className={`iv-space ${r.kind} ${r.use ?? ""} ${isTarget(r) ? "target" : ""}`} />
                ))}
                {plan.map((r, i) =>
                  r.ref ? (
                    <text key={`t${i}`} x={xy(r.center)[0]} y={xy(r.center)[1]} className={`iv-label ${isTarget(r) ? "target" : ""}`}>
                      {r.ref}
                    </text>
                  ) : null,
                )}
                {/* The way, on this floor: walked part solid, the rest dashed. */}
                {way.legs.map((l, k) =>
                  l.level !== level ? null : (
                    <g key={`w${k}`}>
                      <path d={linePath(legsXY[k])} className="iv-way ahead" />
                      <path d={linePath(partLine(legsXY[k], legDone(k)))} className="iv-way done" />
                    </g>
                  ),
                )}
                {/* Where you change floor. */}
                {way.legs.map((l, k) => {
                  if (k === 0 || (l.level !== level && way.legs[k - 1].level !== level)) return null;
                  const [x, y] = legsXY[k][0];
                  const up = l.level > way.legs[k - 1].level;
                  const arriving = l.level === level;
                  // Keep the label clear of "Enter here" when the stairs are right by the door.
                  const byDoor = !!door && level === way.legs[0].level && segLen(xy(door.lngLat), [x, y]) < 60;
                  return (
                    <g key={`c${k}`} transform={`translate(${x},${y})`} className="iv-change">
                      <rect x="-11" y="-11" width="22" height="22" rx="5" />
                      <text y="5">{l.via === "elevator" ? "E" : arriving ? (up ? "↥" : "↧") : up ? "↑" : "↓"}</text>
                      <text y={byDoor ? 27 : -17} className="iv-change-label">
                        {arriving ? `From ${levelLabel(way.legs[k - 1].level).toLowerCase()}` : `${l.via === "elevator" ? "Elevator" : "Stairs"} ${up ? "up" : "down"}`}
                      </text>
                    </g>
                  );
                })}
                {/* Doors, on the floor you come in on. */}
                {level === way.legs[0].level &&
                  (building.entrances ?? []).map((d, i) => {
                    const [x, y] = xy(d.lngLat);
                    const used = d === door;
                    const cls = used ? "used" : d.wheelchair === "yes" ? "accessible" : d.kind === "main" ? "main" : d.kind === "emergency" ? "emergency" : "";
                    return (
                      <g key={`d${i}`} transform={`translate(${x},${y})`}>
                        <circle r={used ? 9 : 6} className={`iv-door ${cls}`} />
                        {used && (
                          <text y="-14" className="iv-door-label">
                            Enter here
                          </text>
                        )}
                      </g>
                    );
                  })}
              </g>
              {level === animLevel && (
                <g transform={`translate(${dot[0]},${dot[1]})`} className={`iv-me ${phase.kind === "change" ? "changing" : ""}`}>
                  <circle r="13" className="halo" />
                  <circle r="7" />
                </g>
              )}
              <g transform={`translate(${W - 26}, 26)`} className="iv-north">
                <path d="M0,-12 L6,6 L0,2 L-6,6 Z" />
                <text y="20">N</text>
              </g>
              <g transform={`translate(${PAD}, 16)`} className="iv-scale">
                <line x1="0" y1="0" x2={scaleBarM * scale} y2="0" />
                <text x={scaleBarM * scale + 6} y="4">
                  {scaleBarM} m
                </text>
              </g>
            </svg>
          </div>
        </div>

        <div className="inside-view-foot">
          <ol className="iv-steps">
            {steps.map((s, i) => (
              <li key={i} className={s.stage === stage ? "current" : s.stage < stage ? "done" : ""}>
                {s.text}
              </li>
            ))}
          </ol>
          <div className="iv-foot-row">
            <button onClick={playing ? () => setPlaying(false) : clock >= timeline.total ? replay : () => setPlaying(true)}>
              {playing ? "Pause" : clock >= timeline.total ? "Replay" : "Play"}
            </button>
            {pickedLevel !== null && pickedLevel !== animLevel && (
              <button className="link" onClick={() => setPickedLevel(null)}>
                Back to the route
              </button>
            )}
            <span className="muted small">From the building's floor plans in OpenStreetMap.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function changeText(via: "stairs" | "elevator" | undefined, from: number, to: number): string {
  const how = via === "elevator" ? "Take the elevator" : "Take the stairs";
  return `${how} ${to > from ? "up" : "down"} to ${levelLabel(to).toLowerCase()}.`;
}

function last<T>(xs: T[]): T {
  return xs[xs.length - 1];
}

function segLen(a: [number, number], b: [number, number]) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** The point a fraction `f` of the way along a polyline. */
function alongLine(line: [number, number][], f: number): [number, number] {
  return last(partLine(line, f));
}

/** The first fraction `f` of a polyline. */
function partLine(line: [number, number][], f: number): [number, number][] {
  const total = line.slice(1).reduce((s, p, i) => s + segLen(line[i], p), 0);
  let left = Math.max(0, Math.min(1, f)) * total;
  const out: [number, number][] = [line[0]];
  for (let i = 0; i + 1 < line.length; i++) {
    const len = segLen(line[i], line[i + 1]);
    if (left <= len) {
      const t = len ? left / len : 0;
      out.push([line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t]);
      return out;
    }
    left -= len;
    out.push(line[i + 1]);
  }
  return out;
}

function niceMeters(m: number): number {
  for (const n of [5, 10, 20, 25, 50, 100, 200]) if (n >= m) return n;
  return 200;
}
