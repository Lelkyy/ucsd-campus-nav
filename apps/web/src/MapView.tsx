import { EdgeKind, type CampusGraph, type IndoorRoom, type LngLat, type TransitStop } from "@campus/core";
import {
  GeolocateControl,
  LngLatBounds,
  Map as MlMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 derives its worker URL at runtime, which bundlers can't see; have Vite bundle it.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useMemo, useRef, useState } from "react";

const BASE_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const SATELLITE_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const CAMPUS_CENTER: LngLat = [-117.2376, 32.8801];
/** A little room around the campus data's bounding box so edge buildings aren't flush to the screen edge. */
const CAMPUS_PADDING_DEG = 0.002;
/** Roughly "whole campus on a laptop screen". */
const MIN_ZOOM = 14;

export const KIND_COLORS: Record<EdgeKind, string> = {
  [EdgeKind.Path]: "#2f80ed",
  [EdgeKind.Steps]: "#f2994a",
  [EdgeKind.Bike]: "#27ae60",
  [EdgeKind.Custom]: "#d63aff",
  [EdgeKind.Road]: "#8a8f98",
  [EdgeKind.BikeOnly]: "#b4bac2",
  [EdgeKind.Shared]: "#7bd389",
};

/** One drawn piece of a route: walking (dotted blue), riding (green) or a shuttle (its route color). */
export interface RouteLine {
  coordinates: LngLat[];
  kind: "walk" | "bike" | "bus";
  color: string;
}

setWorkerUrl(workerUrl);

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export interface MapViewProps {
  graph: CampusGraph;
  routeLines: RouteLine[] | null;
  connectors: [LngLat, LngLat][];
  stops: TransitStop[];
  showStops: boolean;
  from: LngLat | null;
  to: LngLat | null;
  showNetwork: boolean;
  /** Include bike-only roads in the network overlay (riding mode). */
  bikeNetwork: boolean;
  showSatellite: boolean;
  /** A spot being reported (orange marker). */
  reportPin: LngLat | null;
  /** Your live position while navigating, and whether the map should follow it. */
  userPos: LngLat | null;
  follow: boolean;
  /** Doors of the destination building; `used` is the one the route ends at. */
  doors: { lngLat: LngLat; used: boolean }[];
  /** A mapped indoor room to point at, with its label. */
  room: { lngLat: LngLat; label: string } | null;
  /** One floor of a building's indoor map, with the destination room highlighted. */
  /** One floor of the destination's plan, with the indoor route's part on that floor. */
  floorPlan: { rooms: IndoorRoom[]; target?: string; path?: LngLat[][] } | null;
  /** Fly the camera here (bump `key` to repeat). */
  focus: { at: LngLat; zoom: number; key: number } | null;
  /** Taps mark a spot rather than set a route endpoint: show a crosshair. */
  pickingSpot: boolean;
  onMapClick: (p: LngLat) => void;
  onLocate: (p: LngLat) => void;
}

export function MapView(props: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef<{ from: Marker; to: Marker; report: Marker; user: Marker; room: Marker } | null>(null);
  const roomLabel = useRef<HTMLSpanElement | null>(null);
  const [ready, setReady] = useState(false);
  const lastTrip = useRef<string | null>(null);

  // Keep the latest callbacks without re-binding map listeners.
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    // Keep the map on campus: no panning away, no zooming out past it.
    const [w, sth, e, n] = props.graph.data.bbox;
    const map = new MlMap({
      container: container.current!,
      style: BASE_STYLE,
      center: CAMPUS_CENTER,
      zoom: 15.6,
      maxBounds: [
        [w - CAMPUS_PADDING_DEG, sth - CAMPUS_PADDING_DEG],
        [e + CAMPUS_PADDING_DEG, n + CAMPUS_PADDING_DEG],
      ],
      minZoom: MIN_ZOOM,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ visualizePitch: false }), "top-right");
    const geolocate = new GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    });
    map.addControl(geolocate, "top-right");
    geolocate.on("geolocate", (pos) => callbacks.current.onLocate([pos.coords.longitude, pos.coords.latitude]));
    map.addControl(new ScaleControl({ unit: "imperial" }), "bottom-right");

    markers.current = {
      from: new Marker({ color: "#27ae60" }),
      to: new Marker({ color: "#eb5757" }),
      report: new Marker({ color: "#f59e0b" }),
      user: new Marker({ element: dotElement("user-dot") }),
      room: new Marker({ element: roomElement(roomLabel), anchor: "bottom" }),
    };

    map.on("load", () => {
      const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
      map.addSource("satellite", {
        type: "raster",
        tiles: [SATELLITE_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      });
      map.addLayer(
        { id: "satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
        firstSymbol,
      );

      for (const id of ["network", "route", "connectors", "stops", "doors", "floorplan"]) {
        map.addSource(id, { type: "geojson", data: EMPTY });
      }
      map.addLayer({
        id: "network",
        type: "line",
        source: "network",
        layout: { visibility: "none", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 19, 3],
          "line-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "network-nodes",
        type: "circle",
        source: "network",
        minzoom: 18,
        filter: ["==", ["geometry-type"], "Point"],
        layout: { visibility: "none" },
        paint: { "circle-radius": 2.5, "circle-color": "#fff", "circle-stroke-color": "#2f80ed", "circle-stroke-width": 1 },
      });
      map.addLayer({
        id: "stops",
        type: "circle",
        source: "stops",
        layout: { visibility: "none" },
        paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": "#7b61ff", "circle-stroke-width": 2.5 },
      });
      map.addLayer({
        id: "stop-labels",
        type: "symbol",
        source: "stops",
        minzoom: 16,
        layout: {
          visibility: "none",
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-max-width": 9,
        },
        paint: { "text-color": "#4b3aa8", "text-halo-color": "#fff", "text-halo-width": 1.5 },
      });
      // Floor plan (indoor rooms and corridors), under the route.
      map.addLayer({
        id: "fp-fill",
        type: "fill",
        source: "floorplan",
        minzoom: 16.5,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": ["case", ["get", "target"], "#7c3aed", ["==", ["get", "kind"], "room"], "#ffffff", "#e9edf2"],
          "fill-opacity": ["case", ["get", "target"], 0.65, 0.92],
        },
      });
      map.addLayer({
        id: "fp-line",
        type: "line",
        source: "floorplan",
        minzoom: 16.5,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": ["case", ["get", "target"], "#5b21b6", "#94a3b8"], "line-width": ["case", ["get", "target"], 2.5, 1] },
      });
      map.addLayer({
        id: "fp-path",
        type: "line",
        source: "floorplan",
        minzoom: 16.5,
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#5b21b6", "line-width": 3.5, "line-dasharray": [1, 1.6] },
      });
      map.addLayer({
        id: "fp-labels",
        type: "symbol",
        source: "floorplan",
        minzoom: 18.3,
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": ["get", "ref"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["case", ["get", "target"], 13, 10],
          "text-allow-overlap": false,
        },
        paint: { "text-color": ["case", ["get", "target"], "#ffffff", "#475569"], "text-halo-color": ["case", ["get", "target"], "#5b21b6", "#ffffff"], "text-halo-width": 1.2 },
      });
      // Walking legs are dotted; rides are solid (bike green, shuttle in the route's color).
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        filter: ["!=", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0b3d91", "line-width": 11 },
      });
      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        filter: ["==", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#1a56db", "line-width": 7, "line-dasharray": [0.01, 1.6] },
      });
      map.addLayer({
        id: "route-ride",
        type: "line",
        source: "route",
        filter: ["!=", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 7 },
      });
      map.addLayer({
        id: "doors",
        type: "circle",
        source: "doors",
        minzoom: 16,
        paint: {
          "circle-radius": ["case", ["get", "used"], 7, 4.5],
          "circle-color": ["case", ["get", "used"], "#16a34a", "#ffffff"],
          "circle-stroke-color": ["case", ["get", "used"], "#ffffff", "#14532d"],
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "connectors",
        type: "line",
        source: "connectors",
        paint: { "line-color": "#0b3d91", "line-width": 3, "line-dasharray": [1, 1.5] },
      });
      setReady(true);
    });

    map.on("click", (e) => callbacks.current.onMapClick([e.lngLat.lng, e.lngLat.lat]));

    return () => map.remove();
  }, []);

  const networkData = useMemo(() => buildNetworkGeoJson(props.graph), [props.graph]);

  // Sync data and visibility into the map once it's loaded.
  useEffect(() => {
    if (ready) source(mapRef.current!, "network").setData(networkData);
  }, [ready, networkData]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current!;
    const vis = (on: boolean) => (on ? "visible" : "none");
    map.setLayoutProperty("network", "visibility", vis(props.showNetwork));
    // Walkers only see the walking network; riders also see the roads they can use.
    map.setFilter("network", props.bikeNetwork ? null : ["!=", ["get", "kind"], EdgeKind.BikeOnly]);
    map.setLayoutProperty("network-nodes", "visibility", vis(props.showNetwork));
    map.setLayoutProperty("satellite", "visibility", vis(props.showSatellite));
    map.setLayoutProperty("stops", "visibility", vis(props.showStops));
    map.setLayoutProperty("stop-labels", "visibility", vis(props.showStops));
  }, [ready, props.showNetwork, props.bikeNetwork, props.showSatellite, props.showStops]);

  useEffect(() => {
    if (!ready) return;
    source(mapRef.current!, "stops").setData({
      type: "FeatureCollection",
      features: props.stops.map((s) => ({
        type: "Feature",
        properties: { name: s.name },
        geometry: { type: "Point", coordinates: s.lngLat },
      })),
    });
  }, [ready, props.stops]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current!;
    const lines = props.routeLines ?? [];
    source(map, "route").setData({
      type: "FeatureCollection",
      // Rides last so they draw over the walking legs they meet.
      features: [...lines]
        .sort((a, b) => Number(a.kind !== "walk") - Number(b.kind !== "walk"))
        .map((l) => ({ ...lineFeature(l.coordinates), properties: { kind: l.kind, color: l.color } })),
    });
    source(map, "connectors").setData({
      type: "FeatureCollection",
      features: props.connectors.map((c) => lineFeature(c)),
    });
    // Only re-frame when the trip changes, not on every re-render.
    const tripKey = JSON.stringify([callbacks.current.from, callbacks.current.to]);
    const all = lines.flatMap((l) => l.coordinates);
    if (all.length > 1 && tripKey !== lastTrip.current) {
      lastTrip.current = tripKey;
      const bounds = new LngLatBounds(all[0], all[0]);
      const pins = [callbacks.current.from, callbacks.current.to].filter((p): p is LngLat => !!p);
      for (const p of [...all, ...props.connectors.flat(), ...pins]) bounds.extend(p);
      map.fitBounds(bounds, { padding: fitPadding(), maxZoom: 18, duration: 600 });
    }
  }, [ready, props.routeLines, props.connectors]);

  useEffect(() => {
    const map = mapRef.current;
    const m = markers.current;
    if (!map || !m) return;
    for (const [marker, pos] of [
      [m.from, props.from],
      [m.to, props.to],
      [m.report, props.reportPin],
      [m.user, props.userPos],
      [m.room, props.room?.lngLat ?? null],
    ] as const) {
      if (pos) marker.setLngLat(pos).addTo(map);
      else marker.remove();
    }
    if (roomLabel.current) roomLabel.current.textContent = props.room?.label ?? "";
  }, [props.from, props.to, props.reportPin, props.userPos, props.room]);

  // Navigation: keep your position in view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.follow || !props.userPos) return;
    map.easeTo({ center: props.userPos, zoom: Math.max(map.getZoom(), 17.5), duration: 600, padding: fitPadding() });
  }, [props.follow, props.userPos]);

  useEffect(() => {
    if (!ready) return;
    const plan = props.floorPlan;
    const isTarget = (r: IndoorRoom) => !!plan?.target && r.ref?.toUpperCase() === plan.target.toUpperCase();
    source(mapRef.current!, "floorplan").setData({
      type: "FeatureCollection",
      features: (plan?.rooms ?? []).flatMap((r): GeoJSON.Feature[] => [
        {
          type: "Feature",
          properties: { kind: r.kind, target: isTarget(r) },
          geometry: { type: "Polygon", coordinates: [r.outline!] },
        },
        ...(r.ref ? [{ type: "Feature" as const, properties: { ref: r.ref, target: isTarget(r) }, geometry: { type: "Point" as const, coordinates: r.center } }] : []),
      ]).concat(
        (plan?.path ?? []).map((line) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } })),
      ),
    });
  }, [ready, props.floorPlan]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.focus) return;
    map.flyTo({ center: props.focus.at, zoom: props.focus.zoom, duration: 900, padding: fitPadding() });
  }, [props.focus]);

  useEffect(() => {
    if (!ready) return;
    source(mapRef.current!, "doors").setData({
      type: "FeatureCollection",
      features: props.doors.map((d) => ({ type: "Feature", properties: { used: d.used }, geometry: { type: "Point", coordinates: d.lngLat } })),
    });
  }, [ready, props.doors]);

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = props.pickingSpot ? "crosshair" : "";
  }, [props.pickingSpot]);

  return <div ref={container} className="map" />;
}

/** Room around a fitted route so it isn't hidden under the panel (desktop) or sheet (phone). */
function fitPadding() {
  if (window.innerWidth > 760) return { top: 60, right: 70, bottom: 60, left: 440 };
  return { top: 70, right: 40, bottom: Math.round(window.innerHeight * 0.5), left: 40 };
}

function dotElement(className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

/** A small pill pointing at a room ("1202 · Ground level"). */
function roomElement(label: { current: HTMLSpanElement | null }): HTMLElement {
  const el = document.createElement("div");
  el.className = "room-pin";
  const text = document.createElement("span");
  el.appendChild(text);
  label.current = text;
  return el;
}

function source(map: MlMap, id: string): GeoJSONSource {
  return map.getSource(id) as GeoJSONSource;
}

function lineFeature(coords: LngLat[]): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
}

/** Every edge as a colored segment, plus nodes (shown when zoomed in, for tracing). */
function buildNetworkGeoJson(graph: CampusGraph): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let e = 0; e < graph.edgeCount; e++) {
    const a = graph.edgeFrom[e];
    const b = graph.edgeTo[e];
    features.push({
      type: "Feature",
      properties: { color: KIND_COLORS[graph.kind(e)], kind: graph.kind(e) },
      geometry: { type: "LineString", coordinates: [graph.coord(a), graph.coord(b)] },
    });
  }
  for (let i = 0; i < graph.nodeCount; i++) {
    if (graph.adjStart[i + 1] === graph.adjStart[i]) continue;
    features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: graph.coord(i) } });
  }
  return { type: "FeatureCollection", features };
}
