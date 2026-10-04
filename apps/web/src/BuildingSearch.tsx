import { endpointLabel, parseRoom, searchBuildings, searchPlaces, type Building, type Endpoint, type Place } from "@campus/core";
import { useId, useMemo, useState } from "react";
import { CloseIcon } from "./Icons.tsx";

interface Props {
  label: string;
  value: Endpoint | null;
  buildings: Building[];
  /** Student place names, shuttle stops and your saved places. */
  places?: Place[];
  placeholder: string;
  active?: boolean;
  onSelect: (e: Endpoint | null) => void;
  onFocus?: () => void;
  /** Keep the label for screen readers only (the From/To fields show it visually instead). */
  hideLabel?: boolean;
}

type Result = { kind: "building"; building: Building } | { kind: "place"; place: Place };

const PLACE_KIND: Record<Place["kind"], string> = { saved: "Saved", lingo: "Student name", stop: "Shuttle stop" };

/**
 * Search for a destination: buildings (names, codes like "CENTR", code + room
 * like "WLH 2001") and places (student names, stops, your saved spots).
 */
export function BuildingSearch({ label, value, buildings, places = [], placeholder, active, onSelect, onFocus, hideLabel }: Props) {
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const results = useMemo<Result[]>(() => {
    if (!query) return [];
    const p = searchPlaces(places, query, 4).map((place): Result => ({ kind: "place", place }));
    const b = searchBuildings(buildings, query, 8 - p.length).map((building): Result => ({ kind: "building", building }));
    // A place whose name matches exactly goes first; otherwise buildings lead.
    const exact = p.filter((r) => r.kind === "place" && [r.place.name, ...r.place.aliases].some((n) => n.toLowerCase() === query.trim().toLowerCase()));
    return [...exact, ...b, ...p.filter((r) => !exact.includes(r))];
  }, [buildings, places, query]);
  const editing = query !== null;

  const choose = (r: Result) => {
    onSelect(r.kind === "building" ? { kind: "building", building: r.building, room: parseRoom(query ?? "") } : { kind: "place", place: r.place });
    setQuery(null);
  };

  return (
    <div className={`search ${active ? "active" : ""}`}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </label>
      <div className="search-row">
        <input
          id={id}
          value={editing ? query : value ? endpointLabel(value) : ""}
          placeholder={placeholder}
          autoComplete="off"
          onFocus={(e) => {
            onFocus?.();
            e.currentTarget.select();
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onBlur={() => setTimeout(() => setQuery(null), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setHighlight((h) => Math.min(h + 1, results.length - 1));
            else if (e.key === "ArrowUp") setHighlight((h) => Math.max(h - 1, 0));
            else if (e.key === "Enter" && results[highlight]) choose(results[highlight]);
            else if (e.key === "Escape") e.currentTarget.blur();
            else return;
            e.preventDefault();
          }}
        />
        {value && (
          <button className="icon-btn" aria-label={`Clear ${label}`} onClick={() => onSelect(null)}>
            <CloseIcon />
          </button>
        )}
      </div>
      {editing && results.length > 0 && (
        <ul className="results" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.kind === "building" ? r.building.id : r.place.id}
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? "hl" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
            >
              {r.kind === "building" ? (
                <>
                  <span>{r.building.name}</span>
                  <small>
                    <RoomCheck building={r.building} room={parseRoom(query ?? "")} />
                    {r.building.aliases.slice(0, 2).join(" · ")}
                  </small>
                </>
              ) : (
                <>
                  <span>{r.place.name}</span>
                  <small className={`place-kind ${r.place.kind}`}>{PLACE_KIND[r.place.kind]}</small>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && query && results.length === 0 && <div className="results empty">No matching place</div>}
    </div>
  );
}

/** Confirms a typed room against the rooms classes actually meet in, when we know them. */
function RoomCheck({ building, room }: { building: Building; room?: string }) {
  if (!room || !building.rooms?.length) return null;
  const ok = building.rooms.includes(room.toUpperCase());
  return <span className={ok ? "room-ok" : "room-missing"}>{ok ? `room ${room} ✓` : `no room ${room} in schedule`} · </span>;
}
