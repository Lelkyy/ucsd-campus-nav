import { MEETING_TYPES, endpointLabel, floorPhrase, type Building, type CampusSearch, type ClassMeeting, type Endpoint, type FloorGuess, type Place, type SectionMeeting, type SearchHit } from "@campus/core";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { storage } from "./data.ts";
import { HOME_ID } from "./useSavedPlaces.ts";
import { BookIcon, BuildingIcon, ClockIcon, CloseIcon, DoorIcon, HomeIcon, LocateIcon, PinIcon, SearchIcon } from "./Icons.tsx";

interface Props {
  label: string;
  value: Endpoint | null;
  search: CampusSearch;
  buildingById: Map<string, Building>;
  placeById: Map<string, Place>;
  /** Your schedule: shown when the box is empty, and matched first. */
  classes?: ClassMeeting[];
  placeholder: string;
  active?: boolean;
  onSelect: (e: Endpoint | null) => void;
  onFocus?: () => void;
  /** Offer "Your location" (the start field). */
  onMyLocation?: () => void;
  /** Your saved home, offered first; without one, `onSetHome` offers to save it. */
  home?: Place | null;
  onSetHome?: () => void;
  /** Keep the label for screen readers only (the From/To fields show it visually instead). */
  hideLabel?: boolean;
}

/** What was picked before, kept on this device. */
type Recent = { kind: "building"; id: string; room?: string } | { kind: "place"; id: string };
const RECENT_KEY = "campus-nav:recent-search";
const RECENT_MAX = 6;

/** One row in the list: what choosing it does, and how it looks. */
interface Option {
  key: string;
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  pick: () => void;
}

const PLACE_KIND: Record<Place["kind"], string> = { saved: "Saved place", lingo: "Student name", stop: "Shuttle stop" };

/**
 * The search box for a start or destination: classes ("CSE 11"), rooms in any
 * format ("WLH 2001", "wlh2001"), buildings by name, code or nickname (typos
 * forgiven), student place names and stops. Empty, it offers your location,
 * your classes and recent picks. A full keyboard combobox.
 */
export function BuildingSearch({
  label,
  value,
  search,
  buildingById,
  placeById,
  classes = [],
  placeholder,
  active,
  onSelect,
  onFocus,
  onMyLocation,
  home,
  onSetHome,
  hideLabel,
}: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [recents, setRecents] = useState<Recent[]>(() => storage.get<Recent[]>(RECENT_KEY, []));

  const choose = (e: Endpoint, recent?: Recent) => {
    onSelect(e);
    if (recent) {
      const next = [recent, ...recents.filter((r) => JSON.stringify(r) !== JSON.stringify(recent))].slice(0, RECENT_MAX);
      setRecents(next);
      storage.set(RECENT_KEY, next);
    }
    setQuery(null);
    setOpen(false);
    inputRef.current?.blur();
  };
  const toBuilding = (building: Building, room?: string) => () =>
    choose({ kind: "building", building, room }, { kind: "building", id: building.id, room });
  const toPlace = (place: Place) => () => choose({ kind: "place", place }, { kind: "place", id: place.id });

  const typed = query?.trim() ?? "";
  const options = useMemo<{ heading?: string; options: Option[] }[]>(() => {
    if (typed) {
      const hits = search.search(typed, { classes });
      return [{ options: hits.map((h) => optionFor(h, typed)) }];
    }
    // Empty: your location, your classes, recent picks.
    const groups: { heading?: string; options: Option[] }[] = [];
    if (onMyLocation) {
      const pick = () => {
        setOpen(false);
        inputRef.current?.blur();
        onMyLocation();
      };
      groups.push({ options: [{ key: "me", icon: <LocateIcon />, title: "Your location", pick }] });
    }
    if (home) groups.push({ options: [{ key: "home", icon: <HomeIcon />, title: "Home", detail: "Saved on this device", pick: toPlace(home) }] });
    else if (onSetHome) {
      const pick = () => {
        setOpen(false);
        inputRef.current?.blur();
        onSetHome();
      };
      groups.push({ options: [{ key: "set-home", icon: <HomeIcon />, title: "Set your home", detail: "Save it for one-tap directions", pick }] });
    }
    const mine = uniqueClasses(classes)
      .map((m) => ({ m, b: buildingById.get(m.buildingId) }))
      .filter((x): x is { m: ClassMeeting; b: Building } => !!x.b)
      .slice(0, 4)
      .map(({ m, b }) => optionFor({ kind: "class", meeting: m, building: b }, ""));
    if (mine.length) groups.push({ heading: "Your classes", options: mine });
    const recent = recents
      .map((r): Option | null => {
        if (r.kind === "place") {
          const p = placeById.get(r.id);
          return p ? { key: `r-p-${p.id}`, icon: <ClockIcon />, title: p.name, detail: PLACE_KIND[p.kind], pick: toPlace(p) } : null;
        }
        const b = buildingById.get(r.id);
        if (!b) return null;
        const floor = r.room ? search.floorOf(b, r.room) : undefined;
        return {
          key: `r-b-${b.id}-${r.room ?? ""}`,
          icon: <ClockIcon />,
          title: r.room ? `${codeOf(b) ?? b.name} ${r.room}` : b.name,
          detail: r.room ? joinDetail(floor && floorShort(floor), codeOf(b) ? b.name : undefined) : codesLine(b),
          pick: toBuilding(b, r.room),
        };
      })
      .filter((o): o is Option => !!o);
    if (recent.length) groups.push({ heading: "Recent", options: recent });
    return groups;
    // optionFor/toBuilding/toPlace only close over stable values and setters.
  }, [typed, search, classes, recents, buildingById, placeById, onMyLocation, home, onSetHome]);

  function optionFor(h: SearchHit, q: string): Option {
    switch (h.kind) {
      case "class": {
        const m = h.meeting;
        const floor = m.room ? search.floorOf(h.building, m.room) : undefined;
        return {
          key: `c-${m.id}`,
          icon: <BookIcon />,
          title: `${m.course}${m.type ? ` · ${m.type}` : ""}`,
          detail: joinDetail(`${m.buildingCode ?? codeOf(h.building) ?? h.building.name} ${m.room ?? ""}`.trim(), floor && floorShort(floor), whenText(m)),
          pick: toBuilding(h.building, m.room),
        };
      }
      case "course": {
        // A course while its code is being typed; else one section: "CSE 8B · Lecture 002".
        const kind = MEETING_TYPES[h.meeting.type] ?? h.meeting.type;
        const where = `${codeOf(h.building) ?? h.building.name}${h.room ? ` ${h.room}` : ""}`;
        const floor = h.room ? search.floorOf(h.building, h.room) : undefined;
        return {
          key: `k-${h.course.code}-${h.section}`,
          icon: <BookIcon />,
          title: h.listing ? `${h.course.code} · ${h.course.title}` : `${h.course.code} · ${kind} ${h.section}`,
          detail: h.listing
            ? joinDetail(`${kind} ${h.section}`, sectionWhen(h.meeting), where)
            : joinDetail(sectionWhen(h.meeting), where, floor && floorShort(floor)),
          pick: toBuilding(h.building, h.room),
        };
      }
      case "room":
        return {
          key: `m-${h.building.id}-${h.room}`,
          icon: <DoorIcon />,
          title: `${codeOf(h.building) ?? h.building.name} ${h.room}`,
          detail: joinDetail(h.floor && floorShort(h.floor), h.building.name, h.scheduled ? undefined : "not a listed classroom"),
          pick: toBuilding(h.building, h.room),
        };
      case "building":
        return {
          key: `b-${h.building.id}`,
          icon: <BuildingIcon />,
          title: h.building.name,
          detail: codesLine(h.building, q),
          pick: toBuilding(h.building),
        };
      case "place":
        return { key: `p-${h.place.id}`, icon: h.place.id === HOME_ID ? <HomeIcon /> : <PinIcon />, title: h.place.name, detail: PLACE_KIND[h.place.kind], pick: toPlace(h.place) };
    }
  }

  const flat = options.flatMap((g) => g.options);
  const shown = open && (flat.length > 0 || !!typed);
  const hl = Math.min(highlight, Math.max(0, flat.length - 1));
  const optionId = (i: number) => `${listId}-${i}`;

  let index = 0;
  return (
    <div className={`search ${active ? "active" : ""}`}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </label>
      <div className="search-row">
        <span className="search-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          id={id}
          className="search-input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={listId}
          aria-activedescendant={shown && flat.length ? optionId(hl) : undefined}
          value={query ?? (value ? endpointLabel(value) : "")}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onFocus={(e) => {
            onFocus?.();
            // The other field may have added a recent pick since this one loaded.
            setRecents(storage.get<Recent[]>(RECENT_KEY, []));
            setOpen(true);
            setHighlight(0);
            e.currentTarget.select();
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onBlur={() => {
            setQuery(null);
            setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setHighlight(flat.length ? (hl + 1) % flat.length : 0);
            else if (e.key === "ArrowUp") setHighlight(flat.length ? (hl - 1 + flat.length) % flat.length : 0);
            else if (e.key === "Enter" && flat[hl]) flat[hl].pick();
            else if (e.key === "Escape") {
              if (query !== null) setQuery(null);
              else e.currentTarget.blur();
            } else return;
            e.preventDefault();
          }}
        />
        {(value || query) && (
          <button
            className="icon-btn"
            aria-label={`Clear ${label}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQuery("");
              onSelect(null);
              inputRef.current?.focus();
            }}
          >
            <CloseIcon />
          </button>
        )}
      </div>
      {shown && (
        <div className="results" id={listId} role="listbox" aria-label={`${label} suggestions`}>
          {flat.length === 0 && <div className="results-empty">No building, room, class or place matches “{typed}”.</div>}
          {options.map((g, gi) => (
            <div key={gi} role="group" aria-label={g.heading}>
              {g.heading && <div className="results-heading">{g.heading}</div>}
              {g.options.map((o) => {
                const i = index++;
                return (
                  <div
                    key={o.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === hl}
                    className={`result ${i === hl ? "hl" : ""}`}
                    // mousedown, not click: picking must happen before the input's blur closes the list.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      o.pick();
                    }}
                    onMouseMove={() => i !== hl && setHighlight(i)}
                  >
                    <span className="result-icon">{o.icon}</span>
                    <span className="result-text">
                      <span className="result-title">{highlightMatch(o.title, typed)}</span>
                      {o.detail && <span className="result-detail">{o.detail}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function codeOf(b: Building): string | undefined {
  return b.aliases.find((a) => /^[A-Z][A-Z0-9-]{1,5}$/.test(a));
}

/** "WLH · Warren Lecture Hall" style line of a building's codes and best nickname. */
function codesLine(b: Building, q = ""): string | undefined {
  const codes = b.aliases.filter((a) => /^[A-Z][A-Z0-9-]{1,5}$/.test(a)).slice(0, 3);
  // If the match came from a nickname, show it so the result makes sense ("Literature" -> HDSI).
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const viaAlias =
    words.length &&
    !words.every((w) => b.name.toLowerCase().includes(w)) &&
    !codes.some((c) => c.toLowerCase().startsWith(words.join("")))
      ? b.aliases.find((a) => !codes.includes(a) && words.every((w) => a.toLowerCase().includes(w)))
      : undefined;
  return joinDetail(codes.join(" · ") || undefined, viaAlias && `also “${viaAlias}”`);
}

/** "Second floor", "Basement": the floor pointer, short enough for a list. */
function floorShort(floor: FloorGuess): string {
  const p = floorPhrase(floor).replace(/^(on the|in the|on) /, "");
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function joinDetail(...parts: (string | undefined | false | null | 0)[]): string | undefined {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length ? kept.join(" · ") : undefined;
}

function whenText(m: ClassMeeting): string | undefined {
  if (!m.days.length) return undefined;
  const [h, min] = m.start.split(":").map(Number);
  const t = `${((h + 11) % 12) + 1}${min ? `:${String(min).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  return `${m.days.join("")} ${t}`;
}

/** "TuTh 9:30–10:50am". */
function sectionWhen(m: SectionMeeting): string | undefined {
  if (!m.days.length) return undefined;
  const t = (hhmm: string) => {
    const [h, min] = hhmm.split(":").map(Number);
    return `${((h + 11) % 12) + 1}${min ? `:${String(min).padStart(2, "0")}` : ""}`;
  };
  const pm = Number(m.end.split(":")[0]) >= 12;
  return `${m.days.join("")} ${t(m.start)}–${t(m.end)}${pm ? "pm" : "am"}`;
}

/** One entry per course and room (a lecture meets three times a week but is one place). */
function uniqueClasses(classes: ClassMeeting[]): ClassMeeting[] {
  const seen = new Set<string>();
  return classes.filter((m) => {
    const k = `${m.course}|${m.buildingId}|${m.room ?? ""}`;
    if (m.date || !m.buildingId || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Bold the parts of a title that start with a typed word. */
function highlightMatch(text: string, q: string): ReactNode {
  const words = q
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return text;
  const re = new RegExp(`(^|[\\s(·-])(${words.join("|")})`, "gi");
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1].length;
    if (start > last) out.push(text.slice(last, start));
    out.push(<mark key={start}>{m[2]}</mark>);
    last = start + m[2].length;
  }
  out.push(text.slice(last));
  return out;
}
