import { type LiveVehicle, type LngLat, type TransitNetwork } from "@campus/core";
import { LngLatBounds, Map as MlMap, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import { settings } from "../settings.ts";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export interface MapClicks {
  onStop: (stopId: string) => void;
  onVehicle: (vehicle: LiveVehicle) => void;
  /** A click that hit neither a stop nor a vehicle. */
  onEmpty: () => void;
}

/** A bus or trolley line the trip uses: its whole route, and the stretch you ride. */
export interface JourneyLine {
  color: string;
  route: LngLat[];
  ridden: LngLat[];
}

/**
 * Owns the map. The rest of the app never talks to MapLibre directly.
 * Call the set* methods when data changes. Click handlers are the only events that leave.
 */
export class CampusMap {
  private readonly map: MlMap;
  private ready: Promise<void>;
  private vehicles: LiveVehicle[] = [];

  /** `bbox` is the campus data's [west, south, east, north]: the map can't pan far beyond it. */
  constructor(container: HTMLElement, clicks: MapClicks, bbox: [number, number, number, number]) {
    this.map = new MlMap({
      container,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: visibleCenter(settings.center, settings.zoom),
      zoom: settings.zoom,
      minZoom: settings.minZoom,
      maxBounds: campusBounds(bbox),
    });
    this.map.addControl(new NavigationControl(), "top-right");
    this.ready = new Promise((resolve) => this.map.on("load", () => {
      this.addLayers();
      resolve();
    }));
    this.map.on("click", (event) => {
      // Vehicles first: they're drawn on top, often while waiting at a stop.
      const dot = this.map.queryRenderedFeatures(event.point, { layers: ["vehicles"] })[0];
      const vehicle = dot ? this.vehicles.find((v) => v.id === dot.properties?.id) : undefined;
      if (vehicle) {
        clicks.onVehicle(vehicle);
        return;
      }
      const stop = this.map.queryRenderedFeatures(event.point, { layers: ["stops"] })[0];
      if (stop?.properties?.id) clicks.onStop(String(stop.properties.id));
      else clicks.onEmpty();
    });
  }

  /** The stops. Lines aren't drawn until a trip uses them or a vehicle is clicked. */
  async showTransit(transit: TransitNetwork): Promise<void> {
    await this.ready;
    const { stops } = transit.data;
    this.source("stops").setData({
      type: "FeatureCollection",
      features: stops.map((stop) => ({
        type: "Feature" as const,
        properties: { id: stop.id, name: stop.name },
        geometry: { type: "Point" as const, coordinates: stop.lngLat },
      })),
    });
  }

  async showVehicles(vehicles: LiveVehicle[]): Promise<void> {
    await this.ready;
    this.vehicles = vehicles;
    this.source("vehicles").setData({
      type: "FeatureCollection",
      features: vehicles.map((v) => ({
        type: "Feature" as const,
        properties: { id: v.id, label: v.route, color: v.color },
        geometry: { type: "Point" as const, coordinates: v.lngLat },
      })),
    });
  }

  /** The lines the user asked to see: a clicked stop's or vehicle's routes. */
  async showHighlight(lines: { color: string; coordinates: LngLat[] }[]): Promise<void> {
    await this.ready;
    this.source("highlight").setData({
      type: "FeatureCollection",
      features: lines.filter((l) => l.coordinates.length > 1).map((l) => ({
        type: "Feature" as const,
        properties: { color: l.color },
        geometry: { type: "LineString" as const, coordinates: l.coordinates },
      })),
    });
  }

  /** The planned trip, and the bus and trolley lines it rides (whole route faint, the ridden part bold). */
  async showTrip(coordinates: LngLat[], lines: JourneyLine[] = []): Promise<void> {
    await this.ready;
    this.source("trip").setData(
      coordinates.length > 1
        ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }] }
        : EMPTY,
    );
    this.source("lines").setData({
      type: "FeatureCollection",
      features: lines.flatMap((l) =>
        [
          { coordinates: l.route, ridden: false },
          { coordinates: l.ridden, ridden: true },
        ]
          .filter((part) => part.coordinates.length > 1)
          .map((part) => ({
            type: "Feature" as const,
            properties: { color: l.color, ridden: part.ridden },
            geometry: { type: "LineString" as const, coordinates: part.coordinates },
          })),
      ),
    });
  }

  /** Move the map so the whole trip is in view beside the panel. */
  fitTrip(coordinates: LngLat[]): void {
    if (coordinates.length < 2) return;
    const bounds = coordinates.reduce((b, p) => b.extend(p), new LngLatBounds(coordinates[0], coordinates[0]));
    this.map.fitBounds(bounds, { padding: panelPadding(), maxZoom: 17.5, duration: 600 });
  }

  /** What's in view, with half a view's margin on every side: [west, south, east, north]. */
  bounds(): [number, number, number, number] {
    const b = this.map.getBounds();
    const [dx, dy] = [(b.getEast() - b.getWest()) / 2, (b.getNorth() - b.getSouth()) / 2];
    return [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
  }

  focus(at: LngLat): void {
    this.map.flyTo({ center: at, zoom: Math.max(this.map.getZoom(), 16) });
  }

  private source(id: string): GeoJSONSource {
    return this.map.getSource(id) as GeoJSONSource;
  }

  private addLayers(): void {
    for (const id of ["lines", "highlight", "trip", "stops", "vehicles"]) {
      this.map.addSource(id, { type: "geojson", data: EMPTY });
    }
    this.map.addLayer({
      id: "lines",
      type: "line",
      source: "lines",
      filter: ["!", ["get", "ridden"]],
      paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.45 },
    });
    this.map.addLayer({
      id: "highlight",
      type: "line",
      source: "highlight",
      paint: { "line-color": ["get", "color"], "line-width": 6 },
    });
    this.map.addLayer({
      id: "trip",
      type: "line",
      source: "trip",
      paint: { "line-color": "#17301b", "line-width": 5 },
    });
    this.map.addLayer({
      id: "lines-ridden",
      type: "line",
      source: "lines",
      filter: ["get", "ridden"],
      layout: { "line-cap": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 6 },
    });
    this.map.addLayer({
      id: "stops",
      type: "circle",
      source: "stops",
      // Only once zoomed in past the starting view; zoomed out they cover the map.
      minzoom: 16,
      paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": "#17301b", "circle-stroke-width": 2 },
    });
    this.map.addLayer({
      id: "vehicles",
      type: "circle",
      source: "vehicles",
      paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
    this.map.addLayer({
      id: "vehicle-labels",
      type: "symbol",
      source: "vehicles",
      layout: { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Noto Sans Regular"] },
      paint: { "text-color": "#fff" },
    });
  }
}

/** Map space the panel covers, so "the middle" and the edges are where you can see them. */
function panelPadding(): { top: number; right: number; bottom: number; left: number } {
  if (window.innerWidth > 760) return { top: 60, right: 70, bottom: 60, left: 364 };
  return { top: Math.round(window.innerHeight * 0.5), right: 40, bottom: 40, left: 40 };
}

function pxPerDegree(zoom: number): number {
  return (256 * 2 ** zoom) / 360;
}

/** How far the map can pan: the campus with some room around it, and room for the panel at the widest zoom. */
function campusBounds([w, s, e, n]: [number, number, number, number]): [[number, number], [number, number]] {
  const pad = panelPadding();
  const perDeg = pxPerDegree(settings.minZoom);
  const cos = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const lon = (px: number) => px / perDeg;
  const lat = (px: number) => (px * cos) / perDeg;
  const room = settings.boundsPaddingDeg;
  return [
    [w - room - lon(pad.left), s - room - lat(pad.bottom)],
    [e + room + lon(pad.right), n + room + lat(pad.top)],
  ];
}

/** The map centre that puts `at` in the middle of the part of the map the panel doesn't cover. */
function visibleCenter(at: LngLat, zoom: number): LngLat {
  const pad = panelPadding();
  const perDeg = pxPerDegree(zoom);
  const cos = Math.cos((at[1] * Math.PI) / 180);
  return [at[0] - (pad.left - pad.right) / 2 / perDeg, at[1] - ((pad.bottom - pad.top) / 2) * (cos / perDeg)];
}
