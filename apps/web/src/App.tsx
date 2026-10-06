import {
  CampusSearch,
  bearing,
  haversine,
  MODES,
  buildSteps,
  findRoom,
  type IndoorData,
  formatFare,
  routeLabel,
  transitOptions,
  tripFare,
  insideHints,
  endpointLabel,
  endpointPosition,
  CLASS_BUFFER_MIN,
  nextOccurrence,
  startOn,
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
import { PALETTE } from "./palette.ts";
import { MapLayersMenu } from "./MapLayersMenu.tsx";
import { MapView, type BaseMap, type CampusPlaces, type DayOverlay, type RouteLine } from "./MapView.tsx";
import {
  BikeIcon,
  BusIcon,
  ChevronIcon,
  CloseIcon,
  FlagIcon,
  HomeIcon,
  StarIcon,
  LocateIcon,
  StepFreeIcon,
  SwapIcon,
  WalkIcon,
} from "./Icons.tsx";
import { InsideCard } from "./InsideCard.tsx";
import { NavigationView } from "./NavigationView.tsx";
import type { DirectionsOptions } from "./DayView.tsx";
import { TimingControl, type TimingState } from "./TimingControl.tsx";
import { TransitPanel } from "./TransitPanel.tsx";
import { PlaceNamer } from "./PlaceNamer.tsx";
import { ReportPanel, type RouteContext } from "./ReportPanel.tsx";
import { HOME_ID, useSavedPlaces } from "./useSavedPlaces.ts";
import { NextUp, SchedulePanel, type ScheduleView } from "./SchedulePanel.tsx";
import { useSchedule } from "./useSchedule.ts";

/** Suggest transit while walking only when it saves at least this much time. */
const SUGGEST_MIN_FASTER = 3;
const BIKE_COLOR = PALETTE.sageDeep;
const MODE_ICONS: Record<ModeId, () => JSX.Element> = { walk: WalkIcon, accessible: StepFreeIcon, bike: BikeIcon, bus: BusIcon };

type Tab = "go" | "schedule" | "report";

export function App() {
  const [data, setData] = useState<CampusData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("go");
  const schedule = useSchedule();
  const saved = useSavedPlaces();
  /** Camera moves ("Show it on the map"). */
  const [focus, setFocus] = useState<{ at: LngLat; zoom: number; key: number } | null>(null);
  /** The "Save place" form under a route is open. */
  const [naming, setNaming] = useState(false);
  /** Saving your home: which field asked (it gets Home once you tap the map). */
  const [settingHome, setSettingHome] = useState<"from" | "to" | null>(null);
  /** The day view's walks and classes, drawn on the map while it's open. */
  const [dayOverlay, setDayOverlay] = useState<DayOverlay | null>(null);
  const [scheduleView, setScheduleView] = useState<ScheduleView>(() => storage.get<ScheduleView>("campus-nav:schedule-view", "day"));
  useEffect(() => storage.set("campus-nav:schedule-view", scheduleView), [scheduleView]);
  /** Rooms mapped indoors (CSE, Cala), for floors and room spots. */
  const indoor = useMemo<IndoorData>(() => data?.indoor ?? {}, [data]);
  /** Live turn-by-turn navigation, and your position while it's running. */
  const [navigating, setNavigating] = useState(false);
  const [userPos, setUserPos] = useState<LngLat | null>(null);

  const [from, setFromRaw] = useState<Endpoint | null>(null);
  const [to, setToRaw] = useState<Endpoint | null>(null);
  /** Leave now, depart at a time, or arrive by a time (e.g. a class start). */
  const [timing, setTiming] = useState<TimingState>({ kind: "now" });
  const arriveBy = timing.kind === "arrive" ? { at: timing.at, label: timing.label } : null;
  const departAt = timing.kind === "depart" ? timing.at : undefined;
  const setArriveBy = (a: { at: Date; label?: string } | null) => setTiming(a ? { kind: "arrive", ...a } : { kind: "now" });
  /** Transit choices: step-free, and which option is selected. */
  const [transitStepFree, setTransitStepFree] = useState<boolean>(() => storage.get("campus-nav:transit-stepfree", false));
  const [selectedOption, setSelectedOption] = useState(0);
  const [clickTarget, setClickTarget] = useState<"from" | "to">("from");
  /** UC San Diego students ride MTS free with the U-Pass; assume a student unless told otherwise. */
  const [upass, setUpass] = useState<boolean>(() => storage.get("campus-nav:upass", true));
  const [mode, setMode] = useState<ModeId>(() => {
    const saved = storage.get<string>("campus-nav:mode", "walk");
    return saved in MODES ? (saved as ModeId) : "walk";
  });
  const [myLocation, setMyLocationRaw] = useState<LngLat | null>(null);
  // Small GPS jitter would re-plan everything that starts from your location; move the dot every ~10 m.
  const setMyLocation = useCallback(
    (p: LngLat) => setMyLocationRaw((cur) => (cur && haversine(cur[0], cur[1], p[0], p[1]) < 10 ? cur : p)),
    [],
  );
  /** Which way you face (compass) or move (GPS), for the cone on your dot. */
  const [compassHeading, setCompassHeading] = useState<number | null>(null);
  const [gpsHeading, setGpsHeading] = useState<number | null>(null);
  useEffect(() => {
    const onTurn = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
      // iOS reports the compass heading directly; elsewhere an absolute alpha counts anticlockwise.
      const h = e.webkitCompassHeading ?? (e.absolute && e.alpha !== null ? 360 - e.alpha : null);
      if (h === null || h === undefined || Number.isNaN(h)) return;
      setCompassHeading((cur) => (cur !== null && Math.abs(((h - cur + 540) % 360) - 180) < 4 ? cur : h));
    };
    const absolute = "ondeviceorientationabsolute" in window;
    const type = absolute ? "deviceorientationabsolute" : "deviceorientation";
    window.addEventListener(type, onTurn as EventListener);
    return () => window.removeEventListener(type, onTurn as EventListener);
  }, []);

  // Where you are, on the map whenever the browser already allows it (never asks by itself:
  // the locate buttons do that). Follows you, and starts as soon as permission is given.
  useEffect(() => {
    if (!navigator.geolocation || !navigator.permissions) return;
    let watch: number | null = null;
    let status: PermissionStatus | null = null;
    const follow = (on: boolean) => {
      if (on && watch === null) {
        watch = navigator.geolocation.watchPosition(
          (pos) => {
            setMyLocation([pos.coords.longitude, pos.coords.latitude]);
            // The direction you're moving, while you're moving.
            const h = pos.coords.heading;
            setGpsHeading(h !== null && !Number.isNaN(h) && (pos.coords.speed ?? 0) > 0.5 ? h : null);
          },
          () => {},
          { enableHighAccuracy: true, maximumAge: 15_000 },
        );
      } else if (!on && watch !== null) {
        navigator.geolocation.clearWatch(watch);
        watch = null;
      }
    };
    navigator.permissions
      .query({ name: "geolocation" })
      .then((s) => {
        status = s;
        follow(s.state === "granted");
        s.onchange = () => follow(s.state === "granted");
      })
      .catch(() => {});
    return () => {
      follow(false);
      if (status) status.onchange = null;
    };
  }, [setMyLocation]);
  const [locating, setLocating] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  /** Phones: the panel is a bottom sheet that can be pulled up. */
  const [sheetOpen, setSheetOpen] = useState(false);
  // Campus or illustrated (anything saved from before those were the only two is campus).
  const [baseMap, setBaseMap] = useState<BaseMap>(() => (storage.get<string>("campus-nav:base-map", "campus") === "illustrated" ? "illustrated" : "campus"));
  useEffect(() => storage.set("campus-nav:base-map", baseMap), [baseMap]);
  const [placeCategories, setPlaceCategories] = useState<string[]>(() => storage.get<string[]>("campus-nav:place-categories", []));
  useEffect(() => storage.set("campus-nav:place-categories", placeCategories), [placeCategories]);
  // UCSD's places (restrooms, food, water...), fetched when first shown.
  const [campusPlaces, setCampusPlaces] = useState<CampusPlaces | null>(null);
  useEffect(() => {
    fetch("/data/campus-places.json")
      .then((r) => (r.ok ? (r.json() as Promise<CampusPlaces>) : null))
      .then(setCampusPlaces)
      .catch(() => setCampusPlaces(null));
  }, []);

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
    const room = findRoom(indoor[e.building.id], e.room);
    return room ? { ...e, roomAt: room.center } : e;
  };

  // A room pinned (or newly mapped) while it's the destination: route to the door nearest it.
  useEffect(() => {
    setToRaw((t) => (t?.kind === "building" && t.room && !t.roomAt ? withRoom(t) : t));
  }, [indoor]);

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
  useEffect(() => storage.set("campus-nav:upass", upass), [upass]);

  useEffect(() => storage.set("campus-nav:transit-stepfree", transitStepFree), [transitStepFree]);

  const planFor = useCallback(
    (m: ModeId, a: Endpoint, b: Endpoint, when: Date | undefined, leaveAt?: Date): Plan | null =>
      data
        ? planRoute(data.graph, a, b, {
            profile: MODES[m].profile,
            transit: MODES[m].transit ? data.transit : null,
            walkWeight: MODES[m].walkWeight,
            arriveBy: when,
            departAt: leaveAt,
          })
        : null,
    [data],
  );

  /** Google-Maps-style transit choices for a trip (walking included when it's competitive). */
  const transitFor = useCallback(
    (a: Endpoint, b: Endpoint, t: { arriveBy?: Date; departAt?: Date }) =>
      data
        ? transitOptions(data.graph, a, b, { transit: data.transit, timing: t, stepFree: transitStepFree })
        : null,
    [data, transitStepFree],
  );
  const transitResult = useMemo(
    () => (from && to ? transitFor(from, to, { arriveBy: arriveBy?.at, departAt }) : null),
    [transitFor, from, to, arriveBy?.at, departAt],
  );
  // A new trip, time or setting starts from the top option.
  useEffect(() => setSelectedOption(0), [transitResult]);
  const transitOpts = transitResult?.options ?? [];
  const bestTransit = transitOpts.find((o) => !o.walkOnly) ?? null;
  const busUnavailable = transitResult && !bestTransit ? "No shuttle, bus or trolley route found for this trip." : null;
  const transitPlan: Plan | null = transitOpts[selectedOption]
    ? { ok: true, route: transitOpts[selectedOption].route, connectors: transitResult!.connectors }
    : transitResult?.error
      ? { ok: false, error: transitResult.error }
      : null;

  const walkPlan = useMemo(
    () => (from && to ? planFor("walk", from, to, arriveBy?.at, departAt) : null),
    [planFor, from, to, arriveBy?.at, departAt],
  );
  // "No stairs" is only offered when a step-free route exists.
  const stepFreePlan = useMemo(
    () => (from && to ? planFor("accessible", from, to, arriveBy?.at, departAt) : null),
    [planFor, from, to, arriveBy?.at, departAt],
  );
  const noStairsUnavailable = stepFreePlan && !stepFreePlan.ok ? "Every route there has stairs." : null;
  const bikePlan = useMemo(
    () => (from && to ? planFor("bike", from, to, arriveBy?.at, departAt) : null),
    [planFor, from, to, arriveBy?.at, departAt],
  );

  /** Each mode's option for this trip: its plan, or why it isn't offered. */
  const options: Record<ModeId, { plan: Plan | null; unavailable: string | null }> = {
    walk: { plan: walkPlan, unavailable: null },
    accessible: { plan: stepFreePlan, unavailable: noStairsUnavailable },
    bike: { plan: bikePlan, unavailable: null },
    bus: { plan: bestTransit ? { ok: true, route: bestTransit.route, connectors: [] } : null, unavailable: busUnavailable },
  };

  const plan = useMemo(() => {
    if (!from || !to) return null;
    // Transit with no transit route at all: show the walk instead (and say why).
    if (mode === "bus") return busUnavailable ? walkPlan : transitPlan;
    // Likewise "No stairs" with no step-free route: show the walk, with a note.
    if (mode === "accessible") return noStairsUnavailable ? walkPlan : stepFreePlan;
    if (mode === "walk") return walkPlan;
    return bikePlan;
  }, [from, to, mode, busUnavailable, walkPlan, transitPlan, noStairsUnavailable, stepFreePlan, bikePlan]);
  const route = plan?.ok ? plan.route : null;

  // Walking: point out transit when it's clearly faster.
  const busSuggestion = useMemo(() => {
    if ((mode !== "walk" && mode !== "accessible") || !bestTransit || !route) return null;
    const saved = arriveBy
      ? (bestTransit.route.leaveAt.getTime() - route.leaveAt.getTime()) / 60_000
      : (route.arriveAt.getTime() - bestTransit.route.arriveAt.getTime()) / 60_000;
    return saved >= SUGGEST_MIN_FASTER ? { route: bestTransit.route, savedMin: Math.round(saved) } : null;
  }, [mode, bestTransit, route, arriveBy]);

  /** When to leave the current start for a class (null without a start or a route). */
  const estimateClass = useCallback(
    (buildingId: string, startsAt: Date): Route | null => {
      const start = from ?? (myLocation ? ({ kind: "point", lngLat: myLocation, label: "My location" } as Endpoint) : null);
      const building = data?.buildingById.get(buildingId);
      if (!start || !building) return null;
      const arrive = new Date(startsAt.getTime() - CLASS_BUFFER_MIN * 60_000);
      const dest: Endpoint = { kind: "building", building };
      if (mode === "bus" || (building.access === "shuttle" && mode !== "bike")) {
        // The top transit option, as in the Transit list.
        return transitFor(start, dest, { arriveBy: arrive })?.options[0]?.route ?? null;
      }
      const p = planFor(mode, start, dest, arrive);
      if (p?.ok) return p.route;
      // No step-free route there: still say when to leave, using the walk.
      const w = mode === "accessible" ? planFor("walk", start, dest, arrive) : null;
      return w?.ok ? w.route : null;
    },
    [data, from, myLocation, mode, planFor, transitFor],
  );

  /** Getting from one class's building to the next (the day view): on foot, or by bike / step-free in those modes. */
  const estimateBetween = useCallback(
    (fromId: string, toId: string, arrive: Date): Route | null => {
      const a = data?.buildingById.get(fromId);
      const b = data?.buildingById.get(toId);
      if (!a || !b) return null;
      const m: ModeId = mode === "bike" || mode === "accessible" ? mode : "walk";
      const p = planFor(m, { kind: "building", building: a }, { kind: "building", building: b }, arrive);
      return p?.ok ? p.route : null;
    },
    [data, mode, planFor],
  );

  /**
   * The day view's trips to and from your saved home: arriving at a class by
   * `at` ("to"), or leaving one at `at` ("from"). By shuttle in Transit mode,
   * since home is often off campus; otherwise in your mode, on foot as a fallback.
   */
  const estimateHome = useCallback(
    (buildingId: string, dir: "to" | "from", at: Date): Route | null => {
      const building = data?.buildingById.get(buildingId);
      if (!saved.home || !building) return null;
      const home: Endpoint = { kind: "place", place: saved.home };
      const there: Endpoint = { kind: "building", building };
      const [a, b] = dir === "to" ? [home, there] : [there, home];
      const timing = dir === "to" ? { arriveBy: at } : { departAt: at };
      if (mode === "bus") {
        const best = transitFor(a, b, timing)?.options[0]?.route;
        if (best) return best;
      }
      const m: ModeId = mode === "bike" || mode === "accessible" ? mode : "walk";
      const p = planFor(m, a, b, timing.arriveBy, timing.departAt);
      if (p?.ok) return p.route;
      const w = m !== "walk" ? planFor("walk", a, b, timing.arriveBy, timing.departAt) : null;
      return w?.ok ? w.route : null;
    },
    [data, saved.home, mode, planFor, transitFor],
  );

  const allPlaces = useMemo(() => [...saved.places, ...(data?.places.places ?? [])], [saved.places, data]);
  const placeById = useMemo(() => new Map(allPlaces.map((p) => [p.id, p])), [allPlaces]);
  const campusSearch = useMemo(
    () => (data ? new CampusSearch({ buildings: data.buildings, places: allPlaces, courses: data.sections?.courses, indoor }) : null),
    [data, allPlaces, indoor],
  );
  const steps = useMemo(() => (data && route && to ? buildSteps(data.graph, route, endpointLabel(to)) : []), [data, route, to]);
  const destBuilding = to?.kind === "building" ? to.building : null;
  const inside = useMemo(
    () =>
      data && destBuilding && route
        ? insideHints(destBuilding, to?.kind === "building" ? to.room : undefined, indoor[destBuilding.id], route)
        : null,
    [data, destBuilding, to, route, indoor],
  );

  const tips = useMemo(() => {
    if (!data || !destBuilding) return [];
    const codes = destBuilding.aliases.filter((a) => /^[A-Z0-9-]{2,6}$/.test(a));
    const room = to?.kind === "building" ? to.room : undefined;
    return codes.flatMap((c) => [data.places.tips[c], room ? data.places.tips[`${c} ${room}`] : undefined]).filter((t): t is string => !!t);
  }, [data, destBuilding, to]);
  const insideCard =
    destBuilding && inside ? (
      <InsideCard
        buildingName={destBuilding.name}
        hints={inside}
        stepFree={mode === "accessible"}
        tips={tips}
        onShowRoom={inside.roomAt ? () => setFocus({ at: inside.roomAt!, zoom: 19.4, key: Date.now() }) : undefined}
      />
    ) : null;

  // The day view takes over the map: its walks and classes instead of the current route.
  const showingDay = tab === "schedule" && scheduleView === "day" && !!dayOverlay && !navigating;
  // Only the stops the route gets on or off at; the rest of the network stays off the map.
  const routeStops = useMemo(
    () => [...new Map((route?.legs ?? []).flatMap((l) => (l.mode === "bus" ? [l.from, l.to] : [])).map((s) => [s.id, s])).values()],
    [route],
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
    // iOS asks separately for the compass, and only from a tap.
    const orientation = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    orientation.requestPermission?.().catch(() => {});
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

  /** The trip starts from where you are: the start follows you, and shows as your dot. */
  const fromIsMe = from?.kind === "point" && from.label === "My location";
  useEffect(() => {
    if (!fromIsMe || navigating || !myLocation || from?.kind !== "point") return;
    if (from.lngLat[0] !== myLocation[0] || from.lngLat[1] !== myLocation[1]) setFromRaw({ ...from, lngLat: myLocation });
  }, [myLocation, fromIsMe, navigating]);
  // The cone: your compass, else the way you're moving, else the way the route sets off.
  const routeBearing = useMemo(() => {
    const c = fromIsMe ? route?.coordinates : undefined;
    if (!c || c.length < 2) return null;
    const far = c.find((p) => haversine(c[0][0], c[0][1], p[0], p[1]) > 15) ?? c[c.length - 1];
    return bearing(c[0], far);
  }, [route, fromIsMe]);
  const heading = compassHeading ?? gpsHeading ?? routeBearing;

  /** Whether a destination is where your saved home is. */
  const isHome = (e: Endpoint) => {
    if (e.kind === "place" && e.place.id === HOME_ID) return true;
    const h = saved.home?.points[0];
    const p = endpointPosition(e);
    return !!h && h[0] === p[0] && h[1] === p[1];
  };
  useEffect(() => setNaming(false), [to]);

  /** Save your home and put it in the field that asked for it. */
  const saveHome = (points: LngLat[]) => {
    const home = saved.setHome(points);
    if (settingHome === "from") setFrom({ kind: "place", place: home });
    else if (settingHome === "to") setTo({ kind: "place", place: home });
    setSettingHome(null);
    setHint(null);
  };
  const startSettingHome = (field: "from" | "to") => {
    setTab("go");
    setSettingHome(field);
    setHint(null);
  };
  const homeFromLocation = () => {
    if (!navigator.geolocation) return setHint("Location isn't available in this browser.");
    navigator.geolocation.getCurrentPosition(
      (pos) => saveHome([[pos.coords.longitude, pos.coords.latitude]]),
      (err) => setHint(`Couldn't get your location: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const onMapClick = (p: LngLat) => {
    if (!data) return;
    if (tab === "report") return setReportPin(p);
    if (settingHome) return saveHome([p]);
    const pin: Endpoint = { kind: "point", lngLat: p, label: "Dropped pin" };
    if (clickTarget === "from") {
      setFrom(pin);
      setClickTarget("to");
    } else {
      setTo(pin);
    }
    setHint(null);
  };

  /**
   * Directions to a class: for its next meeting, or a given day's (from the day
   * view), starting from your location or from another class's room.
   */
  const onDirections = (meeting: ClassMeeting, opts: Partial<DirectionsOptions> = {}) => {
    const building = data?.buildingById.get(meeting.buildingId);
    if (!building) return setHint("That class isn't at a building on the map.");
    setTab("go");
    setToRaw(withRoom({ kind: "building", building, room: meeting.room }));
    const fromBuilding = opts.from ? data?.buildingById.get(opts.from.buildingId) : undefined;
    if (fromBuilding) setFromRaw(withRoom({ kind: "building", building: fromBuilding, room: opts.from?.room }));
    else if (opts.fromHome && saved.home) setFromRaw({ kind: "place", place: saved.home });
    else if (myLocation) setFromRaw({ kind: "point", lngLat: myLocation, label: "My location" });
    else if (!from) {
      setClickTarget("from");
      setHint("Choose a start: use your location, search, or click the map.");
    }
    if (building.access === "shuttle" && mode !== "bike") setMode("bus");
    const start = opts.date ? startOn(meeting, opts.date) : nextOccurrence(meeting);
    setArriveBy(
      start
        ? {
            at: new Date(start.getTime() - CLASS_BUFFER_MIN * 60_000),
            label: `${meeting.course}${meeting.type ? ` ${meeting.type}` : ""} at ${formatTime(start)}`,
          }
        : null,
    );
  };

  /** Directions home from a class, leaving when it ends (the day view's last class). */
  const onDirectionsHome = (meeting: ClassMeeting, leaveAt: Date) => {
    const building = data?.buildingById.get(meeting.buildingId);
    if (!building || !saved.home) return;
    setTab("go");
    setFromRaw(withRoom({ kind: "building", building, room: meeting.room }));
    setToRaw({ kind: "place", place: saved.home });
    if (building.access === "shuttle" && mode !== "bike") setMode("bus");
    setTiming(leaveAt > new Date() ? { kind: "depart", at: leaveAt } : { kind: "now" });
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
    <div
      className={`app ${navigating ? "navigating" : ""}`}
    >
      {data && (
        <MapView
          graph={data.graph}
          routeLines={showingDay ? null : routeLines}
          day={showingDay ? dayOverlay : null}
          connectors={plan?.ok && !showingDay ? plan.connectors : []}
          stops={showingDay ? [] : routeStops}
          showStops={!showingDay && routeStops.length > 0}
          from={from && !showingDay ? endpointPosition(from) : null}
          fromIsMe={fromIsMe && !showingDay}
          heading={heading}
          to={to && !showingDay ? endpointPosition(to) : null}
          baseMap={baseMap}
          places={campusPlaces}
          placeCategories={placeCategories}
          onPlaceDirections={(p) => {
            setTab("go");
            setTo({ kind: "point", lngLat: p.lngLat, label: p.name });
            setHint(null);
          }}
          reportPin={tab === "report" ? reportPin : null}
          pickingSpot={tab === "report"}
          focus={focus}
          userPos={navigating ? userPos : myLocation}
          follow={navigating}
          doors={(destBuilding?.entrances ?? []).map((d) => ({ lngLat: d.lngLat, used: d === inside?.entrance }))}
          room={
            inside?.roomAt && to?.kind === "building" ? { lngLat: inside.roomAt, label: `${to.room} · ${inside.floor?.label ?? ""}` } : null
          }
          onMapClick={onMapClick}
          onLocate={setMyLocation}
        />
      )}

      <div className="map-tools">
        <MapLayersMenu
          baseMap={baseMap}
          onBaseMap={setBaseMap}
          places={campusPlaces}
          categories={placeCategories}
          onCategories={setPlaceCategories}
        />
      </div>

      <aside className={`sheet ${sheetOpen ? "open" : ""}`} aria-label="Directions and schedule">
        <button className="sheet-handle" aria-label={sheetOpen ? "Collapse panel" : "Expand panel"} onClick={() => setSheetOpen((v) => !v)}>
          <span />
          <ChevronIcon up={!sheetOpen} />
        </button>
        <header className="sheet-head">
          <h1 className="brand">
            <img src="/logo-mark.png" alt="" className="brand-mark" width="26" height="32" />
            Triton Trails
          </h1>
          <nav className="tabs" aria-label="Sections" hidden={navigating}>
            <button className={tab === "go" ? "on" : ""} aria-current={tab === "go"} onClick={() => setTab("go")}>
              Directions
            </button>
            <button className={tab === "schedule" ? "on" : ""} aria-current={tab === "schedule"} onClick={() => setTab("schedule")}>
              Schedule
              {schedule.meetings.length > 0 && <span className="count">{new Set(schedule.meetings.map((m) => m.course)).size}</span>}
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
              <NextUp
                data={data}
                meetings={schedule.meetings}
                estimate={estimateClass}
                onDirections={onDirections}
                onSeeDay={() => {
                  setScheduleView("day");
                  setTab("schedule");
                }}
              />

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
                    search={campusSearch!}
                    buildingById={data.buildingById}
                    placeById={placeById}
                    classes={schedule.meetings}
                    onMyLocation={locate}
                    home={saved.home}
                    onSetHome={() => startSettingHome("from")}
                    value={from}
                    active={clickTarget === "from"}
                    onFocus={() => {
                      setClickTarget("from");
                      // Phones: open the panel so the suggestions have room.
                      setSheetOpen(true);
                    }}
                    onSelect={(e) => {
                      setFrom(e);
                      if (e) setClickTarget("to");
                    }}
                  />
                  <BuildingSearch
                    label="To"
                    hideLabel
                    placeholder="Destination: WLH 2001, CSE 11, Geisel…"
                    search={campusSearch!}
                    buildingById={data.buildingById}
                    placeById={placeById}
                    classes={schedule.meetings}
                    home={saved.home}
                    onSetHome={() => startSettingHome("to")}
                    value={to}
                    active={clickTarget === "to"}
                    onFocus={() => {
                      setClickTarget("to");
                      // Phones: open the panel so the suggestions have room.
                      setSheetOpen(true);
                    }}
                    onSelect={setTo}
                  />
                </div>
                <div className="trip-actions">
                  <button
                    className="icon-btn"
                    onClick={locate}
                    disabled={locating}
                    aria-label="Start from my location"
                    title="Start from my location"
                  >
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
                  const fare =
                    id === "bus" && eta !== null && option.plan?.ok
                      ? tripFare(option.plan.route, data.transit.data.fares, { upass })
                      : null;
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
                      {fare && <span className="mode-fare">{formatFare(fare.total)}</span>}
                    </button>
                  );
                })}
              </div>

              <TimingControl value={timing} onChange={setTiming} />
              {arriveBy?.label && (
                <p className="note">
                  Arriving by <strong>{formatTime(arriveBy.at)}</strong> for {arriveBy.label}.{" "}
                  <button className="link" onClick={() => setArriveBy(null)}>
                    Leave now instead
                  </button>
                </p>
              )}
              {hint && <p className="note warn-note">{hint}</p>}
              {settingHome && (
                <div className="set-home" role="status" ref={(el) => el?.scrollIntoView({ block: "nearest" })}>
                  <span>
                    <strong>Set your home:</strong> tap it on the map.
                  </span>
                  <span className="form-row">
                    <button onClick={homeFromLocation}>Use my location</button>
                    <button className="link" onClick={() => setSettingHome(null)}>
                      Cancel
                    </button>
                  </span>
                </div>
              )}
              {mode === "bus" && busUnavailable && <p className="note warn-note">{busUnavailable} Showing the walk.</p>}
              {mode === "bus" && !busUnavailable && transitOpts.length > 0 && data && (
                <TransitPanel
                  options={transitOpts}
                  selected={selectedOption}
                  onSelect={setSelectedOption}
                  stepFree={transitStepFree}
                  onStepFree={setTransitStepFree}
                  transit={data.transit}
                  fares={data.transit.data.fares}
                  upass={upass}
                  arriving={!!arriveBy}
                />
              )}
              {mode === "accessible" && noStairsUnavailable && (
                <p className="note warn-note">There's no step-free route to this destination. Showing the route with stairs.</p>
              )}
              {plan && !plan.ok && !busSuggestion && <p className="note warn-note">{plan.error}</p>}
              {busSuggestion && (
                <div className="suggest">
                  <BusIcon />
                  <span>
                    {busSuggestion.savedMin === null
                      ? "Only reachable by transit from here."
                      : arriveBy
                        ? `Transit lets you leave ${busSuggestion.savedMin} min later`
                        : `Transit gets you there ${busSuggestion.savedMin} min sooner`}
                    <span className="muted"> · {busName(busSuggestion.route)}</span>
                  </span>
                  <button onClick={() => setMode("bus")}>Take it</button>
                </div>
              )}
              {route && to && (
                <>
                  <Itinerary
                    route={route}
                    destination={endpointLabel(to)}
                    showLeave={timing.kind !== "now"}
                    fare={tripFare(route, data.transit.data.fares, { upass })}
                    upass={upass}
                    onUpass={setUpass}
                  />
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
                  <div className="route-actions">
                    <button onClick={() => setNaming((v) => !v)} aria-expanded={naming}>
                      <StarIcon /> Save place
                    </button>
                    <button
                      disabled={isHome(to)}
                      onClick={() => saved.setHome(to.kind === "place" ? to.place.points : [endpointPosition(to)])}
                    >
                      <HomeIcon /> {isHome(to) ? "Your home" : "Set as home"}
                    </button>
                    <button onClick={() => openReport(true)}>
                      <FlagIcon /> Report
                    </button>
                  </div>
                  {naming && (
                    <PlaceNamer
                      key={endpointLabel(to)}
                      at={endpointPosition(to)}
                      defaultName={to.kind === "point" ? "" : endpointLabel(to)}
                      onSave={(name, note) => saved.add(name, to.kind === "place" ? to.place.points : [endpointPosition(to)], note)}
                      onClose={() => setNaming(false)}
                    />
                  )}
                </>
              )}
              {!to && (saved.places.length > 0 || !saved.home) && (
                <div className="saved-places" aria-label="Your places">
                  {!saved.home && (
                    <span className="place-chip">
                      <button onClick={() => startSettingHome("to")}>
                        <HomeIcon /> Set home
                      </button>
                    </span>
                  )}
                  {saved.places.map((p) => (
                    <span key={p.id} className="place-chip">
                      <button onClick={() => setTo({ kind: "place", place: p })}>
                        {p.id === HOME_ID && <HomeIcon />} {p.name}
                      </button>
                      <button className="icon-btn" aria-label={`Forget ${p.name}`} onClick={() => saved.remove(p.id)}>
                        <CloseIcon />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {!from && !to && (
                <p className="muted small empty-hint">
                  Pick a start and a destination (buildings, rooms like CENTR 115, or places like “Revelle bus stop”), or add your classes
                  in Schedule.
                </p>
              )}
            </>
          ) : tab === "schedule" ? (
            <SchedulePanel
              data={data}
              schedule={schedule}
              view={scheduleView}
              onView={setScheduleView}
              estimateBetween={estimateBetween}
              onDirections={onDirections}
              onDayOverlay={setDayOverlay}
              home={saved.home?.points[0] ?? null}
              estimateHome={estimateHome}
              onDirectionsHome={onDirectionsHome}
              onSetHome={() => startSettingHome("from")}
            />
          ) : (
            <>
              <button className="link back-link" onClick={() => setTab("go")}>
                ‹ Back to directions
              </button>
              <ReportPanel
                buildings={data.buildings}
                pin={reportPin}
                onClearPin={() => setReportPin(null)}
                route={reportRoute}
                dataDate={data.graph.data.generatedAt.slice(0, 10)}
              />
            </>
          )}
        </div>

        <footer className="sheet-foot">
          <span>© OpenStreetMap · UC San Diego Campus Map · Triton Transit &amp; MTS schedules · Unofficial</span>
          {tab !== "report" && !navigating && (
            <button className="link" onClick={() => openReport(false)}>
              Report a problem
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

function busName(route: Route): string {
  const bus = route.legs.find((l) => l.mode === "bus");
  return bus?.mode === "bus" ? `${routeLabel(bus.route)} from ${bus.from.name}` : "";
}
