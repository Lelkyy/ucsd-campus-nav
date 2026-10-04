import type { Leg, Route } from "@campus/core";

/** Door-to-door summary: total time, leave/arrive, and each walking, riding or shuttle leg. */
export function Itinerary({ route, destination, showLeave }: { route: Route; destination: string; showLeave?: boolean }) {
  const showTimes = route.usesTransit || showLeave;
  const byBike = route.legs.some((l) => l.mode === "bike");
  const push = route.legs.reduce((s, l) => s + (l.mode === "bike" ? l.pushMeters : 0), 0);
  return (
    <div className="summary">
      <div className="big">{Math.max(1, Math.ceil(route.minutes))} min</div>
      <div>
        {formatDistance(route.meters)} {byBike ? "by bike" : "walking"}
        {route.stairSegments > 0 && ` · ${route.stairSegments} stair section${route.stairSegments > 1 ? "s" : ""}`}
      </div>
      {byBike && push > 20 && <div className="muted small">Includes {formatDistance(push)} walking your bike on footpaths.</div>}
      <div className="muted">
        {showTimes && `Leave ${formatTime(route.leaveAt)} · `}Arrive {formatTime(route.arriveAt)}
      </div>
      {route.legs.length > 1 && (
        <ol className="legs">
          {route.legs.map((leg, i) => (
            <LegRow key={i} leg={leg} next={route.legs[i + 1]} destination={destination} />
          ))}
        </ol>
      )}
    </div>
  );
}

function LegRow({ leg, next, destination }: { leg: Leg; next?: Leg; destination: string }) {
  if (leg.mode !== "bus") {
    const to = next?.mode === "bus" ? next.from.name : destination;
    return (
      <li className={`leg ${leg.mode}`}>
        {leg.mode === "bike" ? "Ride" : "Walk"} {Math.max(1, Math.ceil(leg.seconds / 60))} min to {to}
      </li>
    );
  }
  return (
    <li className="leg bus" style={{ ["--route" as string]: leg.route.color }}>
      <span className="route-badge">{leg.route.short}</span> <strong>{leg.route.long}</strong> toward {leg.headsign}
      <div className="muted">
        {formatTime(leg.departs)} from {leg.from.name} · {leg.stopCount} stop{leg.stopCount > 1 ? "s" : ""} · off at{" "}
        {leg.to.name} ({formatTime(leg.arrives)})
      </div>
    </li>
  );
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatDistance(meters: number): string {
  const feet = meters * 3.28084;
  return feet < 1000 ? `${Math.round(feet / 10) * 10} ft` : `${(meters / 1609.344).toFixed(2)} mi`;
}
