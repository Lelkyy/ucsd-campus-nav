import { RouteTracker, currentStepIndex, speakDistance, type LngLat, type Route, type Step } from "@campus/core";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDistance, formatTime } from "./Itinerary.tsx";
import { ManeuverIcon } from "./ManeuverIcon.tsx";
import { storage } from "./data.ts";

/** Off the route by more than this, twice in a row, means re-route. */
const OFF_ROUTE_M = 35;
/** Within this of the end counts as arrived. */
const ARRIVE_M = 15;
/** Say the next instruction when it's about this far away. */
const ANNOUNCE_AHEAD_M = 45;
/** Simulation: walk the route this many times faster than real time. */
const SIM_SPEEDUP = 6;

interface Props {
  route: Route;
  steps: Step[];
  destination: string;
  /** Shown on arrival ("Inside the building"). */
  arrival: ReactNode;
  onPosition: (p: LngLat | null) => void;
  /** Off route: plan again from here. */
  onReroute: (p: LngLat) => void;
  onEnd: () => void;
}

type GpsState = "waiting" | "ok" | "denied" | "unavailable";

/**
 * Live turn-by-turn directions: follows your GPS position along the route,
 * shows (and optionally speaks) the next instruction, re-routes when you go
 * off course, and tells you when you've arrived.
 */
export function NavigationView({ route, steps, destination, arrival, onPosition, onReroute, onEnd }: Props) {
  const tracker = useMemo(() => new RouteTracker(route.coordinates), [route]);
  const [along, setAlong] = useState(0);
  const [manualStep, setManualStep] = useState<number | null>(null);
  const [gps, setGps] = useState<GpsState>("waiting");
  const [simulating, setSimulating] = useState(false);
  const [voice, setVoice] = useState(() => storage.get("campus-nav:voice", false));
  const offCount = useRef(0);
  const alongRef = useRef(0);
  const announced = useRef(new Set<string>());

  useEffect(() => storage.set("campus-nav:voice", voice), [voice]);

  // A new route (e.g. after re-routing) starts tracking from scratch.
  useEffect(() => {
    alongRef.current = 0;
    setAlong(0);
    setManualStep(null);
    offCount.current = 0;
    announced.current.clear();
  }, [route]);

  const handle = useRef<(p: LngLat) => void>(() => {});
  handle.current = (p: LngLat) => {
    const loc = tracker.locate(p, alongRef.current);
    if (loc.offRoute > OFF_ROUTE_M) {
      offCount.current++;
      onPosition(p);
      if (offCount.current >= 2) {
        offCount.current = 0;
        onReroute(p);
      }
      return;
    }
    offCount.current = 0;
    // Don't let GPS jitter move you backwards much.
    alongRef.current = Math.max(alongRef.current - 10, loc.along);
    setAlong(alongRef.current);
    setManualStep(null);
    onPosition(loc.point);
  };

  // GPS.
  useEffect(() => {
    if (simulating) return;
    if (!navigator.geolocation) {
      setGps("unavailable");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setGps("ok");
        handle.current([pos.coords.longitude, pos.coords.latitude]);
      },
      (err) => setGps(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [simulating]);

  // Simulated walk/ride along the route (development only).
  useEffect(() => {
    if (!simulating) return;
    const speed = (tracker.total / Math.max(60, route.minutes * 60)) * SIM_SPEEDUP; // m/s
    let simAlong = alongRef.current;
    const t = setInterval(() => {
      simAlong = Math.min(tracker.total, simAlong + speed * 0.5);
      handle.current(tracker.pointAt(simAlong));
      if (simAlong >= tracker.total) setSimulating(false);
    }, 500);
    return () => clearInterval(t);
  }, [simulating, tracker, route]);

  // Keep the screen on while navigating, where supported.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    return () => {
      lock?.release().catch(() => {});
      onPosition(null);
    };
    // Runs once: the lock lives as long as navigation does.
  }, []);

  const arrived = tracker.total - along <= ARRIVE_M;
  const stepIdx = manualStep ?? currentStepIndex(steps, along);
  const next = steps[Math.min(stepIdx + 1, steps.length - 1)];
  const toNext = Math.max(0, next.along - along);
  const remaining = Math.max(0, tracker.total - along);
  const remainingMin = route.minutes * (remaining / Math.max(1, tracker.total));
  const eta = new Date(Date.now() + remainingMin * 60_000);

  // Voice: say each instruction once as you approach it, and announce arrival.
  useEffect(() => {
    if (!voice || !("speechSynthesis" in window)) return;
    const say = (key: string, text: string) => {
      if (announced.current.has(key)) return;
      announced.current.add(key);
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    };
    if (arrived) say("arrived", `You've arrived at ${destination}`);
    else if (toNext <= ANNOUNCE_AHEAD_M) say(`${stepIdx + 1}`, `${next.text}`);
    else say(`ahead-${stepIdx + 1}`, `${speakDistance(toNext)}, ${next.text.charAt(0).toLowerCase()}${next.text.slice(1)}`);
  }, [voice, arrived, stepIdx, toNext, next, destination]);

  return (
    <>
      <div className={`nav-banner ${arrived ? "arrived" : ""}`} role="status" aria-live="polite">
        <span className="nav-icon">
          <ManeuverIcon maneuver={arrived ? "arrive" : next.maneuver} />
        </span>
        <span className="nav-text">
          {!arrived && <span className="nav-dist">{formatDistance(toNext)}</span>}
          <span className="nav-instr">{arrived ? `You've arrived at ${destination}` : next.text}</span>
        </span>
      </div>

      <section className="nav-panel" aria-label="Navigation">
        <div className="nav-summary">
          <span className="itin-time">
            {Math.max(arrived ? 0 : 1, Math.ceil(remainingMin))}
            <small> min</small>
          </span>
          <span className="itin-meta">
            Arrive {formatTime(eta)}
            <span className="muted">{formatDistance(remaining)} to go</span>
          </span>
          <button className="primary end" onClick={onEnd}>
            End
          </button>
        </div>

        {gps === "waiting" && !simulating && <p className="note">Finding your location…</p>}
        {(gps === "denied" || gps === "unavailable") && !simulating && (
          <p className="note warn-note">
            {gps === "denied" ? "Location access is off" : "Can't get your location"}, so use Next and Back to step through the
            directions, or Simulate to watch the walk.
          </p>
        )}

        <div className="form-row wrap">
          <button disabled={stepIdx <= 0} onClick={() => setManualStep(Math.max(0, stepIdx - 1))}>
            Back
          </button>
          <button disabled={stepIdx >= steps.length - 1} onClick={() => setManualStep(Math.min(steps.length - 1, stepIdx + 1))}>
            Next
          </button>
          <label className="toggle">
            <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
            Voice
          </label>
          {/* Without GPS (or while developing), walk the route on screen instead. */}
          {(import.meta.env.DEV || gps !== "ok" || simulating) && (
            <button onClick={() => setSimulating((s) => !s)}>{simulating ? "Stop simulation" : "Simulate"}</button>
          )}
        </div>

        {arrived && arrival}

        <ol className="steps">
          {steps.map((s, i) => (
            <li key={i} className={i === stepIdx + 1 && !arrived ? "current" : i <= stepIdx ? "done" : ""}>
              <span className="step-icon">
                <ManeuverIcon maneuver={s.maneuver} size={20} />
              </span>
              <span>
                {s.text}
                {s.distance > 0 && <span className="muted small block">{formatDistance(s.distance)}</span>}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
