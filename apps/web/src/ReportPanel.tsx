import { distanceMeters, type Building, type LngLat } from "@campus/core";
import { useMemo, useState } from "react";
import { REPORT_EMAIL } from "./config.ts";

const CATEGORIES = [
  "A path is missing",
  "A path doesn't exist or is blocked",
  "Wrong or missing building entrance",
  "Building missing or misnamed",
  "The route was wrong or bad",
  "Shuttle stop or time is wrong",
  "Something else",
] as const;

export interface RouteContext {
  from: string;
  to: string;
  mode: string;
  summary: string;
}

interface Props {
  buildings: Building[];
  /** Spot marked on the map (tap the map while this panel is open). */
  pin: LngLat | null;
  onClearPin: () => void;
  /** The route on screen, if the report is about it. */
  route: RouteContext | null;
  dataDate: string;
}

/** Report a map or routing problem by email (prefilled), or copy the report. */
export function ReportPanel({ buildings, pin, onClearPin, route, dataDate }: Props) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number] | null>(route ? "The route was wrong or bad" : null);
  const [details, setDetails] = useState("");
  const [includeRoute, setIncludeRoute] = useState(!!route);
  const [copied, setCopied] = useState(false);

  const nearest = useMemo(() => {
    if (!pin) return null;
    let best: Building | null = null;
    let bestD = Infinity;
    for (const b of buildings) {
      const d = distanceMeters(pin, b.center);
      if (d < bestD) [best, bestD] = [b, d];
    }
    return best && bestD < 250 ? best : null;
  }, [pin, buildings]);

  const ready = category && (details.trim() || pin);
  const subject = `Campus Nav report: ${category ?? ""}`;
  const body = [
    `Problem: ${category ?? "(not chosen)"}`,
    pin
      ? `Where: ${pin[1].toFixed(6)}, ${pin[0].toFixed(6)}${nearest ? ` (near ${nearest.name})` : ""}\n` +
        `Map: https://www.openstreetmap.org/?mlat=${pin[1].toFixed(6)}&mlon=${pin[0].toFixed(6)}#map=19/${pin[1].toFixed(6)}/${pin[0].toFixed(6)}`
      : "Where: (not marked)",
    includeRoute && route ? `Route: ${route.from} → ${route.to} (${route.mode}): ${route.summary}` : "",
    "",
    "Details:",
    details.trim() || "(none)",
    "",
    `— Sent from Campus Nav (map data ${dataDate})`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");

  return (
    <section className="panel report">
      <div>
        <h2>Report a problem</h2>
        <p className="muted small">
          Spotted a missing path, a wrong entrance or a bad route? Tell us and we'll fix the map.
        </p>
      </div>

      <fieldset className="chips">
        <legend>What's wrong?</legend>
        {CATEGORIES.map((c) => (
          <label key={c} className={category === c ? "on" : ""}>
            <input type="radio" name="category" checked={category === c} onChange={() => setCategory(c)} />
            {c}
          </label>
        ))}
      </fieldset>

      <div className="report-where">
        <span className="report-label">Where</span>
        {pin ? (
          <span>
            {nearest ? `Near ${nearest.name}` : "Marked on the map"}
            <span className="muted small block">
              {pin[1].toFixed(5)}, {pin[0].toFixed(5)} ·{" "}
              <button className="link" onClick={onClearPin}>
                Clear
              </button>
            </span>
          </span>
        ) : (
          <span className="muted">Tap the map to mark the spot.</span>
        )}
      </div>

      {route && (
        <label className="toggle">
          <input type="checkbox" checked={includeRoute} onChange={(e) => setIncludeRoute(e.target.checked)} />
          Include the route on screen ({route.from} → {route.to}, {route.mode})
        </label>
      )}

      <label>
        Details
        <textarea
          rows={4}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="e.g. The stairs behind York Hall are closed for construction"
        />
      </label>

      <div className="form-row wrap">
        <a
          className={`button primary ${ready ? "" : "disabled"}`}
          aria-disabled={!ready}
          href={ready ? `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : undefined}
        >
          Send by email
        </a>
        <button
          disabled={!ready}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(`${subject}\n\n${body}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy report"}
        </button>
      </div>
      {!ready && <p className="muted small">Choose what's wrong, then add details or mark the spot.</p>}
      <p className="muted small">
        Opens your email app with the report filled in, addressed to {REPORT_EMAIL}. No mail app? Copy the report and
        send it there yourself.
      </p>
    </section>
  );
}
