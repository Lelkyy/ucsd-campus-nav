import {
  MODES,
  buildSteps,
  checkBusRoute,
  insideHints,
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
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { BuildingSearch } from "./BuildingSearch.tsx";
import { loadCampus, storage, type CampusData } from "./data.ts";
import { Itinerary, formatDistance, formatTime } from "./Itinerary.tsx";
import { KIND_COLORS, MapView, type RouteLine } from "./MapView.tsx";
import {
  BikeIcon,
  BusIcon,
  ChevronIcon,
  CloseIcon,
  LocateIcon,
  PathsIcon,
  SatelliteIcon,
  StepFreeIcon,
  SwapIcon,
  WalkIcon,
} from "./Icons.tsx";
import { InsideCard } from "./InsideCard.tsx";
import { NavigationView } from "./NavigationView.tsx";
import { PlaceNamer } from "./PlaceNamer.tsx";
import { ReportPanel, type RouteContext } from "./ReportPanel.tsx";
import { useSavedPlaces } from "./useSavedPlaces.ts";
import { NextUp, SchedulePanel } from "./SchedulePanel.tsx";
import { useSchedule } from "./useSchedule.ts";

/** Aim to reach class this many minutes early. */
const CLASS_BUFFER_MIN = 2;
const BIKE_COLOR = "#16a34a";
const MODE_ICONS: Record<ModeId, () => JSX.Element> = { walk: WalkIcon, accessible: StepFreeIcon, bike: BikeIcon, bus: BusIcon };

type Tab = "go" | "schedule" | "report";

export function App() {
  const [data, setData] = useState<CampusData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("go");
  const schedule = useSchedule();
  const saved = useSavedPlaces();
  /** Live turn-by-turn navigation, and your position while it's running. */
  const [navigating, setNavigating] = useState(false);
  const [userPos, setUserPos] = useState<LngLat | null>(null);

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
  /** Phones: the panel is a bottom sheet that can be pulled up. */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showSatellite, setShowSatellite] = useState(false);

  /** Report tab: the spot tapped on the map, and the route the report is about (if any). */
  const [reportPin, setReportPin] = useState<LngLat | null>(null);
  const [reportRoute, setReportRoute] = useState<RouteContext | null>(null);

  // Picking a new start or destination by hand means "leave now" again.
  const setFrom = (e: Endpoint | null) => {
    setFromRaw(e);
    setArriveBy(null);
  };
  const setTo = (e: Endpoint | null) => {
    setToRaw(withRoom(e));
    setArriveBy(null);
  };
  /** Point a building destination at its room, when the room is mapped indoors. */
  const withRoom = (e: Endpoint | null): Endpoint | null => {
    if (e?.kind !== "building" || !e.room || !data) return e;
    const room = data.indoor[e.building.id]?.find((r) => r.ref.toUpperCase() === e.room!.toUpperCase());
    return room ? { ...e, roomAt: room.center } : e;
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

  const planFor = useCallback(
    (m: ModeId, a: Endpoint, b: Endpoint, when: Date | undefined): Plan | null =>
      data
        ? planRoute(data.graph, a, b, {
            profile: MODES[m].profile,
            transit: MODES[m].transit ? data.transit : null,
            walkWeight: MODES[m].walkWeight,
            arriveBy: when,
          })
        : null,
    [data],
  );

  // The bus is only offered when it's a realistic alternative to walking this trip.
  const bus = useMemo(() => {
    if (!from || !to) return null;
    const busPlan = planFor("bus", from, to, arriveBy?.at);
    const walkPlan = planFor("walk", from, to, arriveBy?.at);
    const busRoute = busPlan?.ok ? busPlan.route : null;
    const walkRoute = walkPlan?.ok ? walkPlan.route : null;
    return { plan: busPlan, walkPlan, walkRoute, check: checkBusRoute(busRoute, walkRoute, arriveBy?.at) };
  }, [planFor, from, to, arriveBy]);
  const busUnavailable = bus && !bus.check.ok ? bus.check.reason : null;

  // "No stairs" is only offered when a step-free route exists.
  const stepFreePlan = useMemo(
    () => (from && to ? planFor("accessible", from, to, arriveBy?.at) : null),
    [planFor, from, to, arriveBy],
  );
  const noStairsUnavailable = stepFreePlan && !stepFreePlan.ok ? "Every route there has stairs." : null;
  const bikePlan = useMemo(() => (from && to ? planFor("bike", from, to, arriveBy?.at) : null), [planFor, from, to, arriveBy]);

  /** Each mode's option for this trip: its plan, or why it isn't offered. */
  const options: Record<ModeId, { plan: Plan | null; unavailable: string | null }> = {
    walk: { plan: bus?.walkPlan ?? null, unavailable: null },
    accessible: { plan: stepFreePlan, unavailable: noStairsUnavailable },
    bike: { plan: bikePlan, unavailable: null },
    bus: { plan: bus?.plan ?? null, unavailable: busUnavailable },
  };

  const plan = useMemo(() => {
    if (!from || !to) return null;
    // Bus picked but not realistic for this trip: show the walk instead (and say why).
    if (mode === "bus") return busUnavailable ? (bus?.walkPlan ?? null) : (bus?.plan ?? null);
    // Likewise "No stairs" with no step-free route: show the walk, with a note.
    if (mode === "accessible") return noStairsUnavailable ? (bus?.walkPlan ?? null) : stepFreePlan;
    return planFor(mode, from, to, arriveBy?.at);
  }, [planFor, mode, from, to, arriveBy, bus, busUnavailable, stepFreePlan, noStairsUnavailable]);
  const route = plan?.ok ? plan.route : null;

  // Walking: point out a realistic shuttle that saves a good chunk of walking.
  const busSuggestion = useMemo(() => {
    if ((mode !== "walk" && mode !== "accessible") || !bus?.check.ok || !bus.plan?.ok) return null;
    const busRoute = bus.plan.route;
    const savedMeters = route ? route.meters - busRoute.meters : null;
    return { route: busRoute, savedMeters };
  }, [mode, bus, route]);

  /** When to leave the current start for a class (null without a start or a route). */
  const estimateClass = useCallback(
    (buildingId: string, startsAt: Date): Route | null => {
      const start = from ?? (myLocation ? ({ kind: "point", lngLat: myLocation, label: "My location" } as Endpoint) : null);
      const building = data?.buildingById.get(buildingId);
      if (!start || !building) return null;
      const arrive = new Date(startsAt.getTime() - CLASS_BUFFER_MIN * 60_000);
      const dest: Endpoint = { kind: "building", building };
      if (mode === "bus" || (building.access === "shuttle" && mode !== "bike")) {
        // Same rule as the Bus button: only take the shuttle when it's realistic.
        const b = planFor("bus", start, dest, arrive);
        const w = planFor("walk", start, dest, arrive);
        const busRoute = b?.ok ? b.route : null;
        const walkRoute = w?.ok ? w.route : null;
        return checkBusRoute(busRoute, walkRoute, arrive).ok ? busRoute : walkRoute;
      }
      const p = planFor(mode, start, dest, arrive);
      if (p?.ok) return p.route;
      // No step-free route there: still say when to leave, using the walk.
      const w = mode === "accessible" ? planFor("walk", start, dest, arrive) : null;
      return w?.ok ? w.route : null;
    },
    [data, from, myLocation, mode, planFor],
  );

  const allPlaces = useMemo(() => [...saved.places, ...(data?.places.places ?? [])], [saved.places, data]);
  const steps = useMemo(() => (data && route && to ? buildSteps(data.graph, route, endpointLabel(to)) : []), [data, route, to]);
  const destBuilding = to?.kind === "building" ? to.building : null;
  const inside = useMemo(
    () => (data && destBuilding && route ? insideHints(destBuilding, to?.kind === "building" ? to.room : undefined, data.indoor[destBuilding.id], route) : null),
    [data, destBuilding, to, route],
  );
  const tips = useMemo(() => {
    if (!data || !destBuilding) return [];
    const codes = destBuilding.aliases.filter((a) => /^[A-Z0-9-]{2,6}$/.test(a));
    const room = to?.kind === "building" ? to.room : undefined;
    return codes.flatMap((c) => [data.places.tips[c], room ? data.places.tips[`${c} ${room}`] : undefined]).filter((t): t is string => !!t);
  }, [data, destBuilding, to]);
  const insideCard =
    destBuilding && inside ? (
      <InsideCard buildingName={destBuilding.name} hints={inside} stepFree={mode === "accessible"} tips={tips} />
    ) : null;

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

  const onMapClick = (p: LngLat) => {
    if (!data) return;
    if (tab === "report") return setReportPin(p);
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
    setTab("go");
    setToRaw(withRoom({ kind: "building", building, room: meeting.room }));
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

  /** Open the Report tab, optionally about the route on screen. */
  const openReport = (aboutRoute: boolean) => {
    setReportRoute(
      aboutRoute && route && from && to
        ? {
            from: endpointLabel(from),
            to: endpointLabel(to),
            mode: MODES[mode].label,
            summary: `${Math.ceil(route.minutes)} min, ${formatDistance(route.meters)}`,
          }
        : null,
    );
    if (aboutRoute && to) setReportPin(endpointPosition(to));
    setTab("report");
  };

  if (loadError) return <div className="fatal">Couldn't load campus data. {loadError}</div>;

  return (
    <div className={`app ${navigating ? "navigating" : ""}`}>
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
          reportPin={tab === "report" ? reportPin : null}
          pickingSpot={tab === "report"}
          userPos={navigating ? userPos : null}
          follow={navigating}
          doors={(destBuilding?.entrances ?? []).map((d) => ({ lngLat: d.lngLat, used: d === inside?.entrance }))}
          room={inside?.roomAt && to?.kind === "building" ? { lngLat: inside.roomAt, label: `${to.room} · ${inside.floor?.label ?? ""}` } : null}
          onMapClick={onMapClick}
          onLocate={setMyLocation}
        />
      )}

      <div className="map-tools">
        <button className={`map-chip ${showSatellite ? "on" : ""}`} aria-pressed={showSatellite} onClick={() => setShowSatellite((v) => !v)}>
          <SatelliteIcon /> Satellite
        </button>
        <button className={`map-chip ${showNetwork ? "on" : ""}`} aria-pressed={showNetwork} onClick={() => setShowNetwork((v) => !v)}>
          <PathsIcon /> Paths
        </button>
        {showNetwork && (
          <div className="legend">
            <span style={{ ["--c" as string]: KIND_COLORS[0] }}>Path</span>
            <span style={{ ["--c" as string]: KIND_COLORS[1] }}>Stairs</span>
            <span style={{ ["--c" as string]: KIND_COLORS[2] }}>Bike path</span>
            <span style={{ ["--c" as string]: KIND_COLORS[6] }}>Shared path</span>
            <span style={{ ["--c" as string]: KIND_COLORS[4] }}>Connector road</span>
            {mode === "bike" && <span style={{ ["--c" as string]: KIND_COLORS[5] }}>Road (bikes)</span>}
            <span style={{ ["--c" as string]: KIND_COLORS[3] }}>Hand-mapped</span>
          </div>
        )}
      </div>

      <aside className={`sheet ${sheetOpen ? "open" : ""}`} aria-label="Directions and schedule">
        <button className="sheet-handle" aria-label={sheetOpen ? "Collapse panel" : "Expand panel"} onClick={() => setSheetOpen((v) => !v)}>
          <span />
          <ChevronIcon up={!sheetOpen} />
        </button>
        <header className="sheet-head">
          <h1>Campus Nav</h1>
          <nav className="tabs" aria-label="Sections" hidden={navigating}>
            <button className={tab === "go" ? "on" : ""} aria-current={tab === "go"} onClick={() => setTab("go")}>
              Directions
            </button>
            <button className={tab === "schedule" ? "on" : ""} aria-current={tab === "schedule"} onClick={() => setTab("schedule")}>
              Schedule{schedule.meetings.length > 0 && <span className="count">{new Set(schedule.meetings.map((m) => m.course)).size}</span>}
            </button>
            <button className={tab === "report" ? "on" : ""} aria-current={tab === "report"} onClick={() => openReport(false)}>
              Report
            </button>
          </nav>
        </header>

        <div className="sheet-body">
          {!data ? (
            <p className="muted">Loading campus paths…</p>
          ) : navigating && route && to ? (
            <NavigationView
              route={route}
              steps={steps}
              destination={endpointLabel(to)}
              arrival={insideCard}
              onPosition={setUserPos}
              onReroute={(p) => {
                setFromRaw({ kind: "point", lngLat: p, label: "My location" });
                setArriveBy(null);
              }}
              onEnd={() => {
                setNavigating(false);
                setUserPos(null);
              }}
            />
          ) : tab === "go" ? (
            <>
              <NextUp data={data} meetings={schedule.meetings} estimate={estimateClass} onDirections={onDirections} />

              <div className="trip">
                <div className="trip-rail" aria-hidden>
                  <span className="dot start" />
                  <span className="line" />
                  <span className="dot end" />
                </div>
                <div className="trip-fields">
                  <BuildingSearch
                    label="From"
                    hideLabel
                    placeholder="Start: search or tap the map"
                    buildings={data.buildings}
                    places={allPlaces}
                    value={from}
                    active={clickTarget === "from"}
                    onFocus={() => setClickTarget("from")}
                    onSelect={(e) => {
                      setFrom(e);
                      if (e) setClickTarget("to");
                    }}
                  />
                  <BuildingSearch
                    label="To"
                    hideLabel
                    placeholder="Destination: building, room or place"
                    buildings={data.buildings}
                    places={allPlaces}
                    value={to}
                    active={clickTarget === "to"}
                    onFocus={() => setClickTarget("to")}
                    onSelect={setTo}
                  />
                </div>
                <div className="trip-actions">
                  <button className="icon-btn" onClick={locate} disabled={locating} aria-label="Start from my location" title="Start from my location">
                    <LocateIcon />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => {
                      setFromRaw(to);
                      setToRaw(from);
                    }}
                    disabled={!from && !to}
                    aria-label="Swap start and destination"
                    title="Swap"
                  >
                    <SwapIcon />
                  </button>
                </div>
              </div>

              <div className="modes" role="radiogroup" aria-label="How are you getting there?">
                {(Object.keys(MODES) as ModeId[]).map((id) => {
                  const Icon = MODE_ICONS[id];
                  const option = options[id];
                  const eta = option.unavailable || !option.plan?.ok ? null : Math.max(1, Math.ceil(option.plan.route.minutes));
                  return (
                    <button
                      key={id}
                      role="radio"
                      aria-checked={mode === id}
                      className={mode === id ? "on" : ""}
                      disabled={!!option.unavailable}
                      title={option.unavailable ?? undefined}
                      onClick={() => setMode(id)}
                    >
                      <Icon />
                      <span className="mode-label">{MODES[id].label}</span>
                      {from && to && <span className="mode-eta">{eta === null ? "—" : `${eta} min`}</span>}
                    </button>
                  );
                })}
              </div>

              {arriveBy && (
                <p className="note">
                  Arriving by <strong>{formatTime(arriveBy.at)}</strong> for {arriveBy.label}.{" "}
                  <button className="link" onClick={() => setArriveBy(null)}>
                    Leave now instead
                  </button>
                </p>
              )}
              {hint && <p className="note warn-note">{hint}</p>}
              {mode === "bus" && busUnavailable && (
                <p className="note warn-note">No realistic shuttle for this trip: {busUnavailable.toLowerCase()} Showing the walk.</p>
              )}
              {mode === "accessible" && noStairsUnavailable && (
                <p className="note warn-note">There's no step-free route to this destination. Showing the route with stairs.</p>
              )}
              {plan && !plan.ok && !busSuggestion && <p className="note warn-note">{plan.error}</p>}
              {busSuggestion && (
                <div className="suggest">
                  <BusIcon />
                  <span>
                    {busSuggestion.savedMeters === null
                      ? "Only reachable by shuttle from here."
                      : `Walk ${formatDistance(busSuggestion.route.meters)} instead of ${formatDistance(busSuggestion.route.meters + busSuggestion.savedMeters)}`}
                    <span className="muted"> · {busName(busSuggestion.route)}</span>
                  </span>
                  <button onClick={() => setMode("bus")}>Take it</button>
                </div>
              )}
              {route && to && (
                <>
                  <Itinerary route={route} destination={endpointLabel(to)} showLeave={!!arriveBy} />
                  <button
                    className="primary start"
                    onClick={() => {
                      setNavigating(true);
                      setSheetOpen(false);
                    }}
                  >
                    Start
                  </button>
                  {insideCard}
                  <PlaceNamer
                    key={endpointLabel(to)}
                    at={endpointPosition(to)}
                    defaultName={to.kind === "point" ? "" : endpointLabel(to)}
                    onSave={(name, note) => saved.add(name, to.kind === "place" ? to.place.points : [endpointPosition(to)], note)}
                  />
                  <p className="muted small">
                    Something wrong with this route?{" "}
                    <button className="link" onClick={() => openReport(true)}>
                      Report it
                    </button>
                  </p>
                </>
              )}
              {!to && saved.places.length > 0 && (
                <div className="saved-places" aria-label="Your places">
                  {saved.places.map((p) => (
                    <span key={p.id} className="place-chip">
                      <button onClick={() => setTo({ kind: "place", place: p })}>{p.name}</button>
                      <button className="icon-btn" aria-label={`Forget ${p.name}`} onClick={() => saved.remove(p.id)}>
                        <CloseIcon />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {!from && !to && (
                <p className="muted small empty-hint">
                  Pick a start and a destination (buildings, rooms like CENTR 115, or places like “Revelle bus stop”), or add
                  your classes in Schedule.
                </p>
              )}
            </>
          ) : tab === "schedule" ? (
            <SchedulePanel data={data} schedule={schedule} onDirections={onDirections} />
          ) : (
            <ReportPanel
              buildings={data.buildings}
              pin={reportPin}
              onClearPin={() => setReportPin(null)}
              route={reportRoute}
              dataDate={data.graph.data.generatedAt.slice(0, 10)}
            />
          )}
        </div>

        <footer className="sheet-foot">
          Paths © OpenStreetMap contributors · Shuttle times from Triton Transit (scheduled, not live) · Not an official UC
          San Diego app
        </footer>
      </aside>
    </div>
  );
}

function busName(route: Route): string {
  const bus = route.legs.find((l) => l.mode === "bus");
  return bus?.mode === "bus" ? `${bus.route.long} from ${bus.from.name}` : "";
}
