import {
  formatFare,
  headwayMinutes,
  nextDepartures,
  tripFare,
  type FeedFare,
  type TransitNetwork,
  type TransitOption,
  type TransitPreference,
} from "@campus/core";
import { formatDistance, formatTime } from "./Itinerary.tsx";
import { BusIcon, TrolleyIcon, WalkIcon } from "./Icons.tsx";

const PREFS: { id: TransitPreference; label: string }[] = [
  { id: "best", label: "Best route" },
  { id: "fewer-transfers", label: "Fewer transfers" },
  { id: "less-walking", label: "Less walking" },
];

interface Props {
  options: TransitOption[];
  selected: number;
  onSelect: (i: number) => void;
  preference: TransitPreference;
  onPreference: (p: TransitPreference) => void;
  stepFree: boolean;
  onStepFree: (v: boolean) => void;
  transit: TransitNetwork;
  fares: Record<string, FeedFare>;
  upass: boolean;
  arriving: boolean;
}

/** Google-Maps-style list of transit choices for the trip. */
export function TransitPanel(p: Props) {
  const now = Date.now();
  return (
    <section className="transit" aria-label="Transit options">
      <div className="transit-prefs">
        <div className="segmented small-seg" role="radiogroup" aria-label="Route preference">
          {PREFS.map((pref) => (
            <button
              key={pref.id}
              role="radio"
              aria-checked={p.preference === pref.id}
              className={p.preference === pref.id ? "on" : ""}
              onClick={() => p.onPreference(pref.id)}
            >
              {pref.label}
            </button>
          ))}
        </div>
        <label className="toggle small">
          <input type="checkbox" checked={p.stepFree} onChange={(e) => p.onStepFree(e.target.checked)} />
          Wheelchair accessible
        </label>
      </div>

      <ul className="options" role="radiogroup" aria-label="Routes">
        {p.options.map((o, i) => {
          const rides = o.route.legs.filter((l) => l.mode === "bus");
          const first = rides[0]?.mode === "bus" ? rides[0] : null;
          const fare = tripFare(o.route, p.fares, { upass: p.upass });
          const every = first ? headwayMinutes(p.transit, first) : null;
          const next = first ? nextDepartures(p.transit, first, 2) : [];
          const leavesIn = Math.round((o.route.leaveAt.getTime() - now) / 60_000);
          return (
            <li key={i}>
              <button
                role="radio"
                aria-checked={p.selected === i}
                className={`option ${p.selected === i ? "on" : ""}`}
                onClick={() => p.onSelect(i)}
              >
                <span className="option-top">
                  <span className="option-time">
                    {formatTime(o.route.leaveAt)} – {formatTime(o.route.arriveAt)}
                  </span>
                  <span className="option-min">{Math.max(1, Math.ceil(o.route.minutes))} min</span>
                </span>
                <span className="option-chain" aria-label={o.walkOnly ? "Walk" : "Rides"}>
                  {o.walkOnly ? (
                    <span className="chain-walk">
                      <WalkIcon /> Walk
                    </span>
                  ) : (
                    o.route.legs.map((l, j) =>
                      l.mode === "bus" ? (
                        <span key={j} className="chain-ride" style={{ ["--route" as string]: l.route.color }}>
                          {l.route.mode === "trolley" ? <TrolleyIcon /> : <BusIcon />}
                          <span className="route-badge">{l.route.mode === "trolley" ? `${l.route.short} Line` : l.route.short}</span>
                        </span>
                      ) : (
                        l.seconds >= 60 && (
                          <span key={j} className="chain-walk small">
                            <WalkIcon />
                            {Math.round(l.seconds / 60)}
                          </span>
                        )
                      ),
                    )
                  )}
                  {fare && <span className="option-fare">{formatFare(fare.total)}</span>}
                </span>
                <span className="option-meta muted">
                  {o.walkOnly
                    ? `${formatDistance(o.walkMeters)} on foot`
                    : [
                        first && `${formatTime(first.departs)} from ${first.from.name}`,
                        every ? `every ${every} min` : next.length ? `next ${next.map(formatTime).join(", ")}` : null,
                        `${Math.round(o.walkMinutes)} min walking`,
                        o.boardings > 1 ? `${o.boardings - 1} transfer${o.boardings > 2 ? "s" : ""}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
                {!p.arriving && !o.walkOnly && leavesIn >= 0 && leavesIn <= 30 && (
                  <span className={`option-leave ${leavesIn <= 2 ? "late" : ""}`}>
                    {leavesIn <= 0 ? "Leave now" : `Leave in ${leavesIn} min`}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
