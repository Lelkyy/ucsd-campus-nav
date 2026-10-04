import { EdgeKind, type CampusGraph, type LngLat, type TransitStop } from "@campus/core";
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
  editing: boolean;
  customPaths: GeoJSON.FeatureCollection;
  selectedCustomId: string | null;
  draft: LngLat[];
  onMapClick: (p: LngLat, customFeatureId: string | null) => void;
  onLocate: (p: LngLat) => void;
}

export function MapView(props: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef<{ from: Marker; to: Marker } | null>(null);
  const [ready, setReady] = useState(false);
  const lastTrip = useRef<string | null>(null);

  // Keep the latest callbacks without re-binding map listeners.
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    const map = new MlMap({
      container: container.current!,
      style: BASE_STYLE,
      center: CAMPUS_CENTER,
      zoom: 15.6,
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
    map.addControl(new ScaleControl({ unit: "imperial" }), "bottom-left");

    markers.current = {
      from: new Marker({ color: "#27ae60" }),
      to: new Marker({ color: "#eb5757" }),
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

      for (const id of ["network", "custom", "draft", "route", "connectors", "stops"]) {
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
        id: "custom",
        type: "line",
        source: "custom",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["case", ["boolean", ["get", "selected"], false], "#ffcd00", KIND_COLORS[EdgeKind.Custom]],
          "line-width": 5,
        },
      });
      map.addLayer({
        id: "custom-points",
        type: "circle",
        source: "custom",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 7,
          "circle-color": ["case", ["boolean", ["get", "selected"], false], "#ffcd00", KIND_COLORS[EdgeKind.Custom]],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
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
        id: "connectors",
        type: "line",
        source: "connectors",
        paint: { "line-color": "#0b3d91", "line-width": 3, "line-dasharray": [1, 1.5] },
      });
      map.addLayer({
        id: "draft-line",
        type: "line",
        source: "draft",
        paint: { "line-color": "#ffcd00", "line-width": 4, "line-dasharray": [2, 1] },
      });
      map.addLayer({
        id: "draft-points",
        type: "circle",
        source: "draft",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 5, "circle-color": "#ffcd00", "circle-stroke-color": "#000", "circle-stroke-width": 1 },
      });
      setReady(true);
    });

    map.on("click", (e) => {
      const hit = callbacks.current.editing
        ? map.queryRenderedFeatures(e.point, { layers: ["custom", "custom-points"] })[0]
        : undefined;
      callbacks.current.onMapClick([e.lngLat.lng, e.lngLat.lat], (hit?.properties?.id as string) ?? null);
    });

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
    const features = props.editing
      ? props.customPaths.features.map((f) => ({
          ...f,
          properties: { ...f.properties, selected: f.properties?.id === props.selectedCustomId },
        }))
      : props.customPaths.features;
    source(mapRef.current!, "custom").setData({ type: "FeatureCollection", features });
  }, [ready, props.customPaths, props.selectedCustomId, props.editing]);

  useEffect(() => {
    if (!ready) return;
    const d = props.draft;
    source(mapRef.current!, "draft").setData({
      type: "FeatureCollection",
      features: [
        ...(d.length >= 2 ? [lineFeature(d)] : []),
        ...d.map((p) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: p } })),
      ],
    });
  }, [ready, props.draft]);

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
    // Only re-frame when the trip changes, not when the graph reloads after an edit.
    const tripKey = JSON.stringify([callbacks.current.from, callbacks.current.to]);
    const all = lines.flatMap((l) => l.coordinates);
    if (all.length > 1 && tripKey !== lastTrip.current) {
      lastTrip.current = tripKey;
      const bounds = new LngLatBounds(all[0], all[0]);
      const pins = [callbacks.current.from, callbacks.current.to].filter((p): p is LngLat => !!p);
      for (const p of [...all, ...props.connectors.flat(), ...pins]) bounds.extend(p);
      map.fitBounds(bounds, { padding: 80, maxZoom: 18, duration: 600 });
    }
  }, [ready, props.routeLines, props.connectors]);

  useEffect(() => {
    const map = mapRef.current;
    const m = markers.current;
    if (!map || !m) return;
    for (const [marker, pos] of [
      [m.from, props.from],
      [m.to, props.to],
    ] as const) {
      if (pos) marker.setLngLat(pos).addTo(map);
      else marker.remove();
    }
  }, [props.from, props.to]);

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = props.editing ? "crosshair" : "";
  }, [props.editing]);

  return <div ref={container} className="map" />;
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
