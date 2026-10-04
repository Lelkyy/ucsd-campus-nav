import {
  MODES,
  endpointLabel,
  endpointPosition,
  nextOccurrence,
  planRoute,
  type ClassMeeting,
  type Endpoint,
  type LngLat,
  type ModeId,
  type Plan,
  type Route,
} from "@campus/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BuildingSearch } from "./BuildingSearch.tsx";
import { loadCampus, storage, type CampusData } from "./data.ts";
import { EditPanel, type EditTool } from "./EditPanel.tsx";
import { Itinerary, formatTime } from "./Itinerary.tsx";
import { KIND_COLORS, MapView, type RouteLine } from "./MapView.tsx";
import { SchedulePanel } from "./SchedulePanel.tsx";
import { useSchedule } from "./useSchedule.ts";

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const CUSTOM_API = "/__dev/custom-paths";
/** Draft vertices this close to an existing node snap onto it, so traced paths connect. */
const DRAFT_SNAP_METERS = 5;
/** Aim to reach class this many minutes early. */
const CLASS_BUFFER_MIN = 2;
/** Suggest the bus when it gets you there at least this much sooner. */
const BUS_SUGGEST_MIN = 5;
const BIKE_COLOR = "#16a34a";
const MODE_ICONS: Record<ModeId, string> = { walk: "🚶", accessible: "♿", bike: "🚲", bus: "🚌" };

type Tab = "go" | "edit";

export function App() {
  const [data, setData] = useState<CampusData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("go");
  const schedule = useSchedule();

  const [from, setFromRaw] = useState<Endpoint | null>(null);
  const [to, setToRaw] = useState<Endpoint | null>(null);
  /** Set when routing to a class: plan backwards from its start time. */
  const [arriveBy, setArriveBy] = useState<{ at: Date; label: string } | null>(null);
  const [clickTarget, setClickTarget] = useState<"from" | "to">("from");
  const [mode, setMode] = useState<ModeId>(() => {
    const saved = storage.get<string>("campus-nav:mode", "walk");
    return saved in MODES ? (saved as ModeId) : "walk";
  });
  const [myLocation, setMyLocation] = useState<LngLat | null>(null);
  const [locating, setLocating] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const [showNetwork, setShowNetwork] = useState(false);
  const [showSatellite, setShowSatellite] = useState(false);

  const [tool, setTool] = useState<EditTool>("path");
  const [draft, setDraft] = useState<LngLat[]>([]);
  const [customPaths, setCustomPaths] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Picking a new start or destination by hand means "leave now" again.
  const setFrom = (e: Endpoint | null) => {
    setFromRaw(e);
    setArriveBy(null);
  };
  const setTo = (e: Endpoint | null) => {
    setToRaw(e);
    setArriveBy(null);
  };

  const reload = useCallback(async (bust: boolean) => {
    try {
      const d = await loadCampus(bust);
      setData(d);
      // Building objects are replaced on reload; keep endpoints pointing at fresh ones.
      const refresh = (e: Endpoint | null): Endpoint | null =>
        e?.kind === "building" ? { ...e, building: d.buildingById.get(e.building.id) ?? e.building } : e;
      setFromRaw(refresh);
      setToRaw(refresh);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    reload(false);
  }, [reload]);

  useEffect(() => storage.set("campus-nav:mode", mode), [mode]);

  useEffect(() => {
    if (tab !== "edit") return;
    setShowSatellite(true);
    setShowNetwork(true);
    fetch(CUSTOM_API)
      .then((r) => r.json())
      .then(setCustomPaths)
      .catch(() => setStatus("Editor API unavailable — run `npm run dev`."));
  }, [tab]);

  const planFor = useCallback(
    (m: ModeId, a: Endpoint, b: Endpoint, when: Date | undefined): Plan | null =>
      data
        ? planRoute(data.graph, a, b, {
            profile: MODES[m].profile,
            transit: MODES[m].transit ? data.transit : null,
            arriveBy: when,
          })
        : null,
    [data],
  );

  const plan = useMemo(() => (from && to ? planFor(mode, from, to, arriveBy?.at) : null), [planFor, mode, from, to, arriveBy]);
  const route = plan?.ok ? plan.route : null;

  // Walking: check whether the bus would help (or is the only way there).
  const busSuggestion = useMemo(() => {
    if (!from || !to || (mode !== "walk" && mode !== "accessible")) return null;
    const alt = planFor("bus", from, to, arriveBy?.at);
    if (!alt?.ok || !alt.route.usesTransit) return null;
    if (!route) return { route: alt.route, savedMin: null };
    const saved = arriveBy
      ? (alt.route.leaveAt.getTime() - route.leaveAt.getTime()) / 60_000
      : (route.arriveAt.getTime() - alt.route.arriveAt.getTime()) / 60_000;
    return saved >= BUS_SUGGEST_MIN ? { route: alt.route, savedMin: Math.round(saved) } : null;
  }, [planFor, from, to, mode, arriveBy, route]);

  /** When to leave the current start for a class (null without a start or a route). */
  const estimateClass = useCallback(
    (buildingId: string, startsAt: Date): Route | null => {
      const start = from ?? (myLocation ? ({ kind: "point", lngLat: myLocation, label: "My location" } as Endpoint) : null);
      const building = data?.buildingById.get(buildingId);
      if (!start || !building) return null;
      const m: ModeId = building.access === "shuttle" && mode !== "bike" ? "bus" : mode;
      const p = planFor(m, start, { kind: "building", building }, new Date(startsAt.getTime() - CLASS_BUFFER_MIN * 60_000));
      return p?.ok ? p.route : null;
    },
    [data, from, myLocation, mode, planFor],
  );

  const routeLines: RouteLine[] | null = route
    ? route.legs.map((l) => ({
        coordinates: l.coordinates,
        kind: l.mode,
        color: l.mode === "bus" ? l.route.color : l.mode === "bike" ? BIKE_COLOR : "",
      }))
    : null;

  const locate = () => {
    if (!navigator.geolocation) return setHint("Location isn't available in this browser.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p: LngLat = [pos.coords.longitude, pos.coords.latitude];
        setMyLocation(p);
        setFrom({ kind: "point", lngLat: p, label: "My location" });
        setClickTarget("to");
        setLocating(false);
      },
      (err) => {
        setHint(`Couldn't get your location: ${err.message}`);
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const onMapClick = (p: LngLat, customId: string | null) => {
    if (!data) return;
    if (tab === "edit") {
      if (customId && draft.length === 0) return setSelectedId(customId === selectedId ? null : customId);
      if (tool === "building") return setDraft([p]);
      const node = data.graph.nearestNode(p, { accept: () => true, maxMeters: DRAFT_SNAP_METERS });
      setDraft((d) => [...d, node === -1 ? p : data.graph.coord(node)]);
      return;
    }
    const pin: Endpoint = { kind: "point", lngLat: p, label: "Dropped pin" };
    if (clickTarget === "from") {
      setFrom(pin);
      setClickTarget("to");
    } else {
      setTo(pin);
    }
    setHint(null);
  };

  const onDirections = (meeting: ClassMeeting) => {
    const building = data?.buildingById.get(meeting.buildingId);
    if (!building) return setHint("That class isn't at a building on the map.");
    setToRaw({ kind: "building", building, room: meeting.room });
    if (myLocation) setFromRaw({ kind: "point", lngLat: myLocation, label: "My location" });
    else if (!from) {
      setClickTarget("from");
      setHint("Choose a start: use your location, search, or click the map.");
    }
    if (building.access === "shuttle" && mode !== "bike") setMode("bus");
    const start = nextOccurrence(meeting);
    setArriveBy(
      start
        ? {
            at: new Date(start.getTime() - CLASS_BUFFER_MIN * 60_000),
            label: `${meeting.course}${meeting.type ? ` ${meeting.type}` : ""} at ${formatTime(start)}`,
          }
        : null,
    );
  };

  const saveCustom = async (fc: GeoJSON.FeatureCollection) => {
    setBusy(true);
    setStatus("Saving and rebuilding graph…");
    try {
      const res = await fetch(CUSTOM_API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fc),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setCustomPaths(fc);
      setDraft([]);
      setStatus(body.log);
      await reload(true);
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <div className="fatal">Couldn't load campus data. {loadError}</div>;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>Campus Nav</h1>
          {import.meta.env.DEV && (
            <nav className="segmented" aria-label="Mode">
              <button className={tab === "go" ? "on" : ""} onClick={() => setTab("go")}>
                Directions
              </button>
              <button
                className={tab === "edit" ? "on" : ""}
                onClick={() => {
                  setTab("edit");
                  setDraft([]);
                }}
              >
                Edit map
              </button>
            </nav>
          )}
        </header>

        {!data ? (
          <p className="muted">Loading campus paths…</p>
        ) : tab === "go" ? (
          <>
            <section className="panel">
              <div className="modes" role="radiogroup" aria-label="How are you getting there?">
                {(Object.keys(MODES) as ModeId[]).map((id) => (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={mode === id}
                    className={mode === id ? "on" : ""}
                    onClick={() => setMode(id)}
                  >
                    <span aria-hidden>{MODE_ICONS[id]}</span>
                    {MODES[id].label}
                  </button>
                ))}
              </div>
              <BuildingSearch
                label="From"
                placeholder="Search, or click the map"
                buildings={data.buildings}
                value={from}
                active={clickTarget === "from"}
                onFocus={() => setClickTarget("from")}
                onSelect={(e) => {
                  setFrom(e);
                  if (e) setClickTarget("to");
                }}
              />
              <div className="form-row tight">
                <button onClick={locate} disabled={locating}>
                  {locating ? "Locating…" : "◎ Use my location"}
                </button>
                <button
                  onClick={() => {
                    setFromRaw(to);
                    setToRaw(from);
                  }}
                  disabled={!from && !to}
                  aria-label="Swap start and destination"
                >
                  ⇅ Swap
                </button>
              </div>
              <BuildingSearch
                label="To"
                placeholder="Building, code or room (e.g. CENTR 115)"
                buildings={data.buildings}
                value={to}
                active={clickTarget === "to"}
                onFocus={() => setClickTarget("to")}
                onSelect={setTo}
              />

              {arriveBy && (
                <p className="muted small">
                  Arriving by {formatTime(arriveBy.at)} for {arriveBy.label}{" "}
                  <button className="link" onClick={() => setArriveBy(null)}>
                    Leave now instead
                  </button>
                </p>
              )}
              {hint && <p className="hint">{hint}</p>}
              {plan && !plan.ok && !busSuggestion && <p className="hint">{plan.error}</p>}
              {busSuggestion && (
                <div className="suggest">
                  <span>
                    {busSuggestion.savedMin === null
                      ? "Only reachable by shuttle from here."
                      : arriveBy
                        ? `The shuttle lets you leave ${busSuggestion.savedMin} min later`
                        : `The shuttle gets you there ${busSuggestion.savedMin} min sooner`}{" "}
                    ({busName(busSuggestion.route)}, arrive {formatTime(busSuggestion.route.arriveAt)})
                  </span>
                  <button className="primary" onClick={() => setMode("bus")}>
                    Take the bus
                  </button>
                </div>
              )}
              {route && to && <Itinerary route={route} destination={endpointLabel(to)} showLeave={!!arriveBy} />}
            </section>

            <SchedulePanel data={data} schedule={schedule} estimate={estimateClass} onDirections={onDirections} />
          </>
        ) : (
          <EditPanel
            tool={tool}
            onTool={(t) => {
              setTool(t);
              setDraft([]);
            }}
            draftLength={draft.length}
            customPaths={customPaths}
            selectedId={selectedId}
            busy={busy}
            status={status}
            onUndo={() => setDraft((d) => d.slice(0, -1))}
            onCancelDraft={() => setDraft([])}
            onFinishLine={() =>
              saveCustom({
                ...customPaths,
                features: [
                  ...customPaths.features,
                  {
                    type: "Feature",
                    properties: { id: crypto.randomUUID(), kind: tool === "steps" ? "steps" : "path" },
                    geometry: { type: "LineString", coordinates: draft },
                  },
                ],
              })
            }
            onAddBuilding={(name, aliases) =>
              saveCustom({
                ...customPaths,
                features: [
                  ...customPaths.features,
                  {
                    type: "Feature",
                    properties: { id: crypto.randomUUID(), name, aliases },
                    geometry: { type: "Point", coordinates: draft[0] },
                  },
                ],
              })
            }
            onSelect={setSelectedId}
            onDelete={(id) =>
              saveCustom({ ...customPaths, features: customPaths.features.filter((f) => f.properties?.id !== id) })
            }
          />
        )}

        <section className="panel layers">
          <label>
            <input type="checkbox" checked={showSatellite} onChange={(e) => setShowSatellite(e.target.checked)} />
            Satellite
          </label>
          <label>
            <input type="checkbox" checked={showNetwork} onChange={(e) => setShowNetwork(e.target.checked)} />
            Path network
          </label>
          {showNetwork && (
            <div className="legend">
              <span style={{ ["--c" as string]: KIND_COLORS[0] }}>path</span>
              <span style={{ ["--c" as string]: KIND_COLORS[1] }}>stairs</span>
              <span style={{ ["--c" as string]: KIND_COLORS[2] }}>bike path</span>
              <span style={{ ["--c" as string]: KIND_COLORS[6] }}>shared path</span>
              <span style={{ ["--c" as string]: KIND_COLORS[4] }}>connector road</span>
              {mode === "bike" && <span style={{ ["--c" as string]: KIND_COLORS[5] }}>road (bikes)</span>}
              <span style={{ ["--c" as string]: KIND_COLORS[3] }}>yours</span>
            </div>
          )}
        </section>
        <footer className="muted small">
          Paths © OpenStreetMap contributors (ODbL). Shuttle times from UC San Diego Triton Transit; check live
          arrivals before relying on them. Not an official UC San Diego app.
        </footer>
      </aside>

      {data && (
        <MapView
          graph={data.graph}
          routeLines={routeLines}
          connectors={plan?.ok ? plan.connectors : []}
          stops={data.transit.data.stops}
          showStops={mode === "bus" || !!route?.usesTransit}
          from={from ? endpointPosition(from) : null}
          to={to ? endpointPosition(to) : null}
          showNetwork={showNetwork}
          bikeNetwork={mode === "bike"}
          showSatellite={showSatellite}
          editing={tab === "edit"}
          customPaths={tab === "edit" ? customPaths : EMPTY_FC}
          selectedCustomId={selectedId}
          draft={tab === "edit" ? draft : []}
          onMapClick={onMapClick}
          onLocate={setMyLocation}
        />
      )}
    </div>
  );
}

function busName(route: Route): string {
  const bus = route.legs.find((l) => l.mode === "bus");
  return bus?.mode === "bus" ? `${bus.route.long} from ${bus.from.name}` : "";
}
