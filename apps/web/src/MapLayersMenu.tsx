import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { SatelliteIcon } from "./Icons.tsx";
import type { BaseMap, CampusPlaces } from "./MapView.tsx";

const BASE_MAPS: { id: BaseMap; label: string; note: string }[] = [
  { id: "map", label: "Map", note: "Paths and buildings" },
  { id: "illustrated", label: "Illustrated", note: "UCSD's drawn campus map" },
  { id: "campus", label: "Campus", note: "The official campus map" },
  { id: "satellite", label: "Satellite", note: "Aerial photos" },
];

/** The map button: which map to draw under the routes, and which of UCSD's places to show. */
export function MapLayersMenu({
  baseMap,
  onBaseMap,
  places,
  categories,
  onCategories,
}: {
  baseMap: BaseMap;
  onBaseMap: (b: BaseMap) => void;
  places: CampusPlaces | null;
  categories: string[];
  onCategories: Dispatch<SetStateAction<string[]>>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Close on a tap outside or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const shown = categories.length;
  const toggle = (id: string) => onCategories((cur) => (cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id]));

  return (
    <div className="layers" ref={root}>
      <button className={`map-chip ${open ? "on" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        <SatelliteIcon /> Map{shown > 0 && <span className="layers-count">{shown}</span>}
      </button>
      {open && (
        <div className="layers-menu" role="dialog" aria-label="Map style and places">
          <div className="layers-section" role="radiogroup" aria-label="Map style">
            {BASE_MAPS.map((b) => (
              <button
                key={b.id}
                role="radio"
                aria-checked={baseMap === b.id}
                className={`layers-base base-${b.id} ${baseMap === b.id ? "on" : ""}`}
                onClick={() => onBaseMap(b.id)}
                title={b.note}
              >
                <span className="layers-thumb" aria-hidden="true" />
                {b.label}
              </button>
            ))}
          </div>
          {places && (
            <>
              <div className="layers-head">
                <strong>Show on the map</strong>
                {shown > 0 && (
                  <button className="link" onClick={() => onCategories([])}>
                    Clear
                  </button>
                )}
              </div>
              <div className="layers-places">
                {places.categories.map((c) => {
                  const on = categories.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      className={`layers-place ${on ? "on" : ""}`}
                      aria-pressed={on}
                      style={{ ["--cat" as string]: c.color }}
                      onClick={() => toggle(c.id)}
                    >
                      <span className="layers-dot" aria-hidden="true" />
                      {c.label}
                    </button>
                  );
                })}
              </div>
              <p className="muted small layers-source">Places from UC San Diego's campus map.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
