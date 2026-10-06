import { type CampusGraph, type LngLat, type TransitStop } from "@campus/core";
import {
  GeolocateControl,
  LngLatBounds,
  Map as MlMap,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type LayerSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PALETTE } from "./palette.ts";
// MapLibre 6 derives its worker URL at runtime, which bundlers can't see; have Vite bundle it.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";

const BASE_STYLE = "https://tiles.openfreemap.org/styles/liberty";
/** UC San Diego's illustrated campus map (by Concept3D, the old maps.ucsd.edu); TMS rows. */
const ILLUSTRATED_TILES = "https://assets.concept3d.com/assets/1005/1005_Map_9/{z}/{x}/{y}";
/** Esri's topographic map, which the official ArcGIS campus map is drawn on. */
const TOPO_TILES = "https://services.arcgisonline.com/arcgis/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}";
/** UC San Diego's campus vector tiles, for its district names and campus boundary. */
const UCSD_VECTOR_TILES = "https://tiles.arcgis.com/tiles/mXNwDpiENQiMIzRv/arcgis/rest/services/CampusMapVectorApril2/VectorTileServer/tile/{z}/{y}/{x}.pbf";

/** The map underneath: the official campus map, or UCSD's illustrated one on top of it. */
export type BaseMap = "campus" | "illustrated";

/** Places from UCSD's campus map (apps/web/public/data/campus-places.json). */
export interface CampusPlaces {
  categories: { id: string; label: string; color: string }[];
  /** [lng, lat, category index, name, kind, building] */
  points: [number, number, number, string, string, string][];
}

/** A place tapped on the map. */
export interface PlacePick {
  lngLat: LngLat;
  name: string;
}
const CAMPUS_CENTER: LngLat = [-117.2376, 32.8801];
/** Room around the campus data's bounding box: enough to see the shore and ocean to the west. */
const CAMPUS_PADDING_DEG = 0.006;
/** Campus and the coast on a laptop screen. */
const MIN_ZOOM = 13.5;
const START_ZOOM = 15.6;

/** One drawn piece of a route: walking (dotted blue), riding (green) or a shuttle (its route color). */
export interface RouteLine {
  coordinates: LngLat[];
  kind: "walk" | "bike" | "bus";
  color: string;
}

setWorkerUrl(workerUrl);

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** A day's classes on the map: the walks between them, and a numbered pin per class. */
export interface DayOverlay {
  lines: { coordinates: LngLat[]; color: string }[];
  /** One pin per building; `n` lists the class numbers there ("1, 4"), `label` one line per class. */
  stops: { lngLat: LngLat; n: string; label: string; color: string }[];
}

export interface MapViewProps {
  graph: CampusGraph;
  routeLines: RouteLine[] | null;
  /** The day view's walks and classes (drawn instead of a route). */
  day?: DayOverlay | null;
  connectors: [LngLat, LngLat][];
  stops: TransitStop[];
  showStops: boolean;
  from: LngLat | null;
  to: LngLat | null;
  baseMap: BaseMap;
  /** UCSD's places, and the categories to show. */
  places: CampusPlaces | null;
  placeCategories: string[];
  onPlaceDirections: (place: PlacePick) => void;
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
  const popup = useRef<Popup | null>(null);
  const osmLayers = useRef<{ id: string; type: string }[]>([]);

  // Keep the latest callbacks without re-binding map listeners.
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    // Keep the map on campus (and its shore), but let every edge be panned out from under the panel.
    const map = new MlMap({
      container: container.current!,
      style: BASE_STYLE,
      center: visibleCenter(CAMPUS_CENTER, START_ZOOM),
      zoom: START_ZOOM,
      maxBounds: campusBounds(props.graph.data.bbox),
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
      from: new Marker({ color: PALETTE.sageDeep }),
      to: new Marker({ color: PALETTE.rose }),
      report: new Marker({ color: PALETTE.clay }),
      user: new Marker({ element: dotElement("user-dot") }),
      room: new Marker({ element: roomElement(roomLabel), anchor: "bottom" }),
    };

    map.on("load", () => {
      // OpenStreetMap's drawing, recolored like the illustrated map: it's what's around the drawing in
      // Illustrated mode (labels and icons stay off, so nothing lands on the drawing). The campus map
      // covers it in Campus mode.
      osmLayers.current = map.getStyle().layers.map((l) => ({ id: l.id, type: l.type }));
      paintLikeIllustrated(map);
      map.addSource("topo", {
        type: "raster",
        tiles: [TOPO_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Campus map © UC San Diego, Esri",
      });
      // Esri's tiles are pale: stronger color (not contrast, which only bleaches light colors) so buildings stand off the campus ground and white paths read.
      map.addLayer({
        id: "topo",
        type: "raster",
        source: "topo",
        paint: { "raster-saturation": 0.7, "raster-brightness-max": 0.93 },
      });
      // The campus map leaves out most footpaths: OpenStreetMap's, on top of it, white with a soft edge.
      for (const [id, color, width] of [
        ["campus-paths-casing", "#b9a8c8", [15, 2.2, 17, 4, 20, 11]],
        ["campus-paths", "#ffffff", [15, 1, 17, 2.2, 20, 7]],
      ] as const) {
        map.addLayer({
          id,
          type: "line",
          source: "openmaptiles",
          "source-layer": "transportation",
          minzoom: 15,
          filter: [
            "all",
            ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
            ["!=", ["get", "brunnel"], "tunnel"],
            ["match", ["get", "class"], ["path", "pedestrian"], true, false],
          ],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": color, "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], ...width] },
        });
      }
      map.addSource("illustrated", {
        type: "raster",
        tiles: [ILLUSTRATED_TILES],
        scheme: "tms",
        tileSize: 256,
        minzoom: 13,
        maxzoom: 20,
        bounds: [-117.26, 32.855, -117.2, 32.895],
        attribution: "Illustrated map © UC San Diego",
      });
      map.addLayer({ id: "illustrated", type: "raster", source: "illustrated", layout: { visibility: "none" } });
      map.addSource("ucsd", { type: "vector", tiles: [UCSD_VECTOR_TILES], minzoom: 0, maxzoom: 16 });
      for (const layer of UCSD_LAYERS) map.addLayer({ ...layer, layout: { ...layer.layout, visibility: "none" } } as LayerSpecification);

      for (const id of ["route", "connectors", "stops", "doors", "day", "places"]) {
        map.addSource(id, { type: "geojson", data: EMPTY });
      }
      // UCSD's places, under everything of the app's; names once zoomed in.
      map.addLayer({
        id: "places",
        type: "circle",
        source: "places",
        filter: ["boolean", false],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 3.5, 17, 6, 19, 8],
          "circle-color": ["get", "color"],
          "circle-stroke-color": PALETTE.white,
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 14, 1, 17, 2],
        },
      });
      map.addLayer({
        id: "place-labels",
        type: "symbol",
        source: "places",
        minzoom: 17.5,
        filter: ["boolean", false],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 0.9],
          "text-anchor": "top",
          "text-max-width": 8,
          "text-optional": true,
        },
        paint: { "text-color": ["get", "color"], "text-halo-color": PALETTE.white, "text-halo-width": 1.5 },
      });
      map.addLayer({
        id: "stops",
        type: "circle",
        source: "stops",
        layout: { visibility: "none" },
        paint: { "circle-radius": 5, "circle-color": PALETTE.white, "circle-stroke-color": PALETTE.oliveDeep, "circle-stroke-width": 2.5 },
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
        paint: { "text-color": PALETTE.oliveDeep, "text-halo-color": PALETTE.white, "text-halo-width": 1.5 },
      });
      // Walking legs are dotted; rides are solid (bike green, shuttle in the route's color).
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        filter: ["!=", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": PALETTE.oliveDeep, "line-width": 11 },
      });
      // A soft white underlay so the dotted walk stays readable over parks and buildings.
      map.addLayer({
        id: "route-walk-halo",
        type: "line",
        source: "route",
        filter: ["==", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": PALETTE.white, "line-width": 11, "line-opacity": 0.75 },
      });
      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        filter: ["==", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": PALETTE.olive, "line-width": 7, "line-dasharray": [0.01, 1.6] },
      });
      map.addLayer({
        id: "route-ride",
        type: "line",
        source: "route",
        filter: ["!=", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 7 },
      });
      // The day view: dotted walks between classes in the next class's color, numbered pins.
      map.addLayer({
        id: "day-line",
        type: "line",
        source: "day",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 6, "line-dasharray": [0.01, 1.6] },
      });
      map.addLayer({
        id: "day-stop",
        type: "circle",
        source: "day",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": ["case", [">", ["length", ["get", "n"]], 1], 15, 11],
          "circle-color": ["get", "color"],
          "circle-stroke-color": PALETTE.white,
          "circle-stroke-width": 2.5,
        },
      });
      map.addLayer({
        id: "day-stop-n",
        type: "symbol",
        source: "day",
        filter: ["==", ["geometry-type"], "Point"],
        layout: { "text-field": ["get", "n"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-allow-overlap": true },
        paint: { "text-color": PALETTE.white },
      });
      map.addLayer({
        id: "day-stop-label",
        type: "symbol",
        source: "day",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "text-offset": [0, 1.5],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: { "text-color": PALETTE.ink, "text-halo-color": PALETTE.white, "text-halo-width": 1.6 },
      });
      map.addLayer({
        id: "doors",
        type: "circle",
        source: "doors",
        minzoom: 16,
        paint: {
          "circle-radius": ["case", ["get", "used"], 7, 4.5],
          "circle-color": ["case", ["get", "used"], PALETTE.olive, PALETTE.white],
          "circle-stroke-color": ["case", ["get", "used"], PALETTE.white, PALETTE.oliveDeep],
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "connectors",
        type: "line",
        source: "connectors",
        paint: { "line-color": PALETTE.oliveDeep, "line-width": 3, "line-dasharray": [1, 1.5] },
      });
      setReady(true);
    });

    map.on("click", (e) => {
      // A place: what it is, and directions to it; anywhere else drops a pin as before.
      const hit = map.getLayer("places")
        ? map.queryRenderedFeatures([
            [e.point.x - 6, e.point.y - 6],
            [e.point.x + 6, e.point.y + 6],
          ], { layers: ["places"] })[0]
        : undefined;
      if (hit && hit.geometry.type === "Point") {
        const at = hit.geometry.coordinates as LngLat;
        const { name, kind, building } = hit.properties as { name: string; kind: string; building: string };
        popup.current?.remove();
        popup.current = new Popup({ closeButton: true, maxWidth: "240px", className: "place-popup" })
          .setLngLat(at)
          .setDOMContent(placeCard(name, kind, building, () => {
            popup.current?.remove();
            callbacks.current.onPlaceDirections({ lngLat: at, name });
          }))
          .addTo(map);
        return;
      }
      callbacks.current.onMapClick([e.lngLat.lng, e.lngLat.lat]);
    });
    map.on("mouseenter", "places", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "places", () => (map.getCanvas().style.cursor = ""));

    return () => map.remove();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current!;
    const vis = (on: boolean) => (on ? "visible" : "none");
    const illustrated = props.baseMap === "illustrated";
    // Campus: the topographic campus map over everything of OpenStreetMap's. Illustrated: the drawing,
    // on OpenStreetMap drawn in its colors.
    map.setLayoutProperty("topo", "visibility", vis(!illustrated));
    map.setLayoutProperty("campus-paths-casing", "visibility", vis(!illustrated));
    map.setLayoutProperty("campus-paths", "visibility", vis(!illustrated));
    map.setLayoutProperty("illustrated", "visibility", vis(illustrated));
    for (const { id, type } of osmLayers.current) {
      if (type !== "background") map.setLayoutProperty(id, "visibility", vis(illustrated && showsUnderDrawing(id, type)));
      // What shows while tiles load: the drawing's green, or the campus map's pale ground.
      else map.setPaintProperty(id, "background-color", illustrated ? "#9cb478" : "#ece8ef");
    }
    for (const layer of UCSD_LAYERS) map.setLayoutProperty(layer.id, "visibility", vis(props.baseMap === "campus"));
  }, [ready, props.baseMap]);

  useEffect(() => {
    if (!ready || !props.places) return;
    const { categories, points } = props.places;
    source(mapRef.current!, "places").setData({
      type: "FeatureCollection",
      features: points.map(([lng, lat, cat, name, kind, building]) => ({
        type: "Feature",
        properties: { cat: categories[cat].id, color: categories[cat].color, name, kind, building },
        geometry: { type: "Point", coordinates: [lng, lat] },
      })),
    });
  }, [ready, props.places]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current!;
    const filter: ExpressionSpecification = ["in", ["get", "cat"], ["literal", props.placeCategories]];
    map.setFilter("places", filter);
    map.setFilter("place-labels", filter);
    if (!props.placeCategories.length) popup.current?.remove();
  }, [ready, props.placeCategories]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current!;
    const vis = (on: boolean) => (on ? "visible" : "none");
    map.setLayoutProperty("stops", "visibility", vis(props.showStops));
    map.setLayoutProperty("stop-labels", "visibility", vis(props.showStops));
  }, [ready, props.showStops]);

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

  // The day view's walks and pins, framed whenever the day (or the choice of classes) changes.
  const lastDay = useRef("");
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current!;
    const day = props.day;
    source(map, "day").setData({
      type: "FeatureCollection",
      features: [
        ...(day?.lines ?? []).map((l) => ({ ...lineFeature(l.coordinates), properties: { color: l.color } })),
        ...(day?.stops ?? []).map((s) => ({
          type: "Feature" as const,
          properties: { n: s.n, label: s.label, color: s.color },
          geometry: { type: "Point" as const, coordinates: s.lngLat },
        })),
      ],
    });
    const pts = [...(day?.lines ?? []).flatMap((l) => l.coordinates), ...(day?.stops ?? []).map((s) => s.lngLat)];
    const key = JSON.stringify(day?.stops.map((s) => s.lngLat) ?? []);
    if (pts.length && key !== lastDay.current) {
      const bounds = new LngLatBounds(pts[0], pts[0]);
      for (const p of pts) bounds.extend(p);
      map.fitBounds(bounds, { padding: fitPadding(), maxZoom: 17.5, duration: 600 });
    }
    lastDay.current = key;
  }, [ready, props.day]);

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
/** Map pixels per degree of longitude at a zoom level. */
function pxPerDegree(zoom: number): number {
  return (256 * 2 ** zoom) / 360;
}

/**
 * How far the map may pan: the campus data's box plus some coast, plus as much
 * again as the panel covers (on the left on a laptop, the bottom on a phone),
 * so nothing is stuck under the search panel.
 */
function campusBounds([w, s, e, n]: [number, number, number, number]): [[number, number], [number, number]] {
  const pad = fitPadding();
  const perDeg = pxPerDegree(MIN_ZOOM);
  const cos = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const lon = (px: number) => px / perDeg;
  const lat = (px: number) => (px * cos) / perDeg;
  return [
    [w - CAMPUS_PADDING_DEG - lon(pad.left), s - CAMPUS_PADDING_DEG - lat(pad.bottom)],
    [e + CAMPUS_PADDING_DEG + lon(pad.right), n + CAMPUS_PADDING_DEG + lat(pad.top)],
  ];
}

/** The map center that puts `at` in the middle of the part of the map the panel doesn't cover. */
function visibleCenter(at: LngLat, zoom: number): LngLat {
  const pad = fitPadding();
  const perDeg = pxPerDegree(zoom);
  const cos = Math.cos((at[1] * Math.PI) / 180);
  return [at[0] - (pad.left - pad.right) / 2 / perDeg, at[1] - ((pad.bottom - pad.top) / 2) * (cos / perDeg)];
}

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


/**
 * From UCSD's campus vector style: the campus boundary and the district and
 * neighborhood names, as on the official ArcGIS campus map (fonts swapped for
 * ones the base map's font server has; names shown a little longer).
 */
const UCSD_LAYERS = [
  {
    id: "ucsd-boundary-glow",
    type: "line",
    source: "ucsd",
    "source-layer": "UCSD Boundary Campus Map",
    minzoom: 13,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "rgba(189,206,222,0.25)",
      "line-width": { base: 1, stops: [[0, 2], [14, 5], [19, 8.3]] },
      "line-offset": -2.1,
      "line-translate": [0, 2],
    },
  },
  {
    id: "ucsd-boundary",
    type: "line",
    source: "ucsd",
    "source-layer": "UCSD Boundary Campus Map",
    minzoom: 13,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "rgba(75,117,166,0.73)",
      "line-width": { base: 1, stops: [[0, 1], [14, 2], [19, 4]] },
      "line-dasharray": [2, 2],
      "line-offset": -2.1,
    },
  },
  {
    id: "ucsd-subdistricts",
    type: "symbol",
    source: "ucsd",
    "source-layer": "UCSD Subdistricts/label",
    minzoom: 14.5,
    maxzoom: 17,
    layout: { "text-field": "{_name}", "text-font": ["Noto Sans Bold"], "text-size": 13, "text-line-height": 0.9, "text-optional": true },
    paint: { "text-color": "#4A6497", "text-halo-color": "rgba(255,255,255,0.8)", "text-halo-width": 2.5 },
  },
  {
    id: "ucsd-districts",
    type: "symbol",
    source: "ucsd",
    "source-layer": "UCSD Districts/label",
    minzoom: 13,
    maxzoom: 14.5,
    layout: {
      "text-field": "{_name}",
      "text-font": ["Noto Sans Bold"],
      "text-size": { base: 1, stops: [[13, 12], [14, 15.5]] },
      "text-max-width": 10,
      "text-line-height": 0.95,
      "text-optional": true,
    },
    paint: { "text-color": "#014B75", "text-halo-color": "rgba(255,255,255,0.8)", "text-halo-width": 3 },
  },
] as const;

/**
 * OpenStreetMap in the illustrated map's colors (sampled from its tiles): grass
 * and wooded canyons in greens, gray roads, cream footpaths, pale gray roofs.
 */
const ILLUSTRATED_PAINT: [RegExp, "background-color" | "fill-color" | "line-color", string][] = [
  [/^background$/, "background-color", "#9cb478"],
  [/^landcover_(grass|wetland)$|^landuse_(pitch|track|cemetery)$/, "fill-color", "#9cb878"],
  [/^park$/, "fill-color", "#90b06c"],
  [/^park_outline$/, "line-color", "#7c9c58"],
  [/^landcover_wood$/, "fill-color", "#6c8a44"],
  [/^landuse_residential$|^landuse_(school|hospital|commercial|industrial|retail)$/, "fill-color", "#a8bc88"],
  [/^landcover_sand$/, "fill-color", "#d6cfa6"],
  [/^water$/, "fill-color", "#6aaed6"],
  [/^waterway/, "line-color", "#6aaed6"],
  [/_casing$/, "line-color", "#5a5a5a"],
  [/^(road|bridge|tunnel)_(path|pedestrian)/, "line-color", "#ece8de"],
  [/^(road|bridge|tunnel)_/, "line-color", "#7a7a7a"],
  [/^building$/, "fill-color", "#cdcdcd"],
];

function paintLikeIllustrated(map: MlMap) {
  for (const layer of map.getStyle().layers) {
    const rule = ILLUSTRATED_PAINT.find(([re]) => re.test(layer.id));
    if (!rule) continue;
    try {
      map.setPaintProperty(layer.id, rule[1], rule[2]);
    } catch {
      // A layer of a different type than expected: leave it as the style draws it.
    }
  }
}

/** Which of OpenStreetMap's layers show around the drawing: flat shapes and lines, no labels, 3D or borders. */
function showsUnderDrawing(id: string, type: string): boolean {
  if (type === "symbol" || type === "fill-extrusion" || type === "raster") return false;
  return !/boundary|aeroway|_pattern$|hatching/.test(id);
}

/** The popup for a tapped place. */
function placeCard(name: string, kind: string, building: string, onGo: () => void): HTMLElement {
  const el = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = name;
  const meta = document.createElement("span");
  meta.className = "place-popup-meta";
  meta.textContent = [kind === name ? "" : kind, building].filter(Boolean).join(" · ");
  const go = document.createElement("button");
  go.className = "primary small-btn";
  go.textContent = "Directions here";
  go.onclick = onGo;
  el.append(title, meta, go);
  return el;
}

