import { endpointLabel, parseRoom, searchBuildings, type Building, type Endpoint } from "@campus/core";
import { useId, useMemo, useState } from "react";

interface Props {
  label: string;
  value: Endpoint | null;
  buildings: Building[];
  placeholder: string;
  active?: boolean;
  onSelect: (e: Endpoint | null) => void;
  onFocus?: () => void;
}

/** Building autocomplete. Accepts names, codes ("CENTR"), and code + room ("WLH 2001"). */
export function BuildingSearch({ label, value, buildings, placeholder, active, onSelect, onFocus }: Props) {
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const results = useMemo(() => (query ? searchBuildings(buildings, query) : []), [buildings, query]);
  const editing = query !== null;

  const choose = (b: Building) => {
    onSelect({ kind: "building", building: b, room: parseRoom(query ?? "") });
    setQuery(null);
  };

  return (
    <div className={`search ${active ? "active" : ""}`}>
      <label htmlFor={id}>{label}</label>
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
            ×
          </button>
        )}
      </div>
      {editing && results.length > 0 && (
        <ul className="results" role="listbox">
          {results.map((b, i) => (
            <li
              key={b.id}
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? "hl" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(b);
              }}
            >
              <span>{b.name}</span>
              <small>
                <RoomCheck building={b} room={parseRoom(query ?? "")} />
                {b.aliases.slice(0, 2).join(" · ")}
              </small>
            </li>
          ))}
        </ul>
      )}
      {editing && query && results.length === 0 && <div className="results empty">No matching building</div>}
    </div>
  );
}

/** Confirms a typed room against the rooms classes actually meet in, when we know them. */
function RoomCheck({ building, room }: { building: Building; room?: string }) {
  if (!room || !building.rooms?.length) return null;
  const ok = building.rooms.includes(room.toUpperCase());
  return <span className={ok ? "room-ok" : "room-missing"}>{ok ? `room ${room} ✓` : `no room ${room} in schedule`} · </span>;
}
