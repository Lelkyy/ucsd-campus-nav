import {
  arrivalsAtStops,
  linesAtStops,
  sameNameCluster,
  shapesAtStops,
  type Endpoint,
  type LiveVehicle,
  type ModeId,
  type SearchHit,
} from "@campus/core";
import { Campus } from "./campus/loadCampus.ts";
import { LiveFeed } from "./live/LiveFeed.ts";
import { ModelFeed } from "./live/ModelFeed.ts";
import { VehicleMotion } from "./live/Motion.ts";
import { settings } from "./settings.ts";
import { CampusMap } from "./map/CampusMap.ts";
import { TripPlanner } from "./trip/TripPlanner.ts";

/**
 * Starts the pieces and connects them.
 * Read this file top to bottom: load campus, draw it, poll buses, then listen to the form.
 */
export class App {
  private campus!: Campus;
  private map!: CampusMap;
  private planner!: TripPlanner;
  private from: Endpoint | null = null;
  private to: Endpoint | null = null;
  private routeFilter: string | null = null;

  constructor(private readonly root: { status: HTMLElement; stop: HTMLElement; trip: HTMLElement }) {}

  async start(): Promise<void> {
    this.campus = await Campus.load();
    this.planner = new TripPlanner(this.campus);
    this.map = new CampusMap(document.querySelector("#map")!, {
      onStop: (id) => this.openStop(id),
      onVehicle: (vehicle) => this.openVehicle(vehicle),
      onEmpty: () => this.closeStop(),
    }, this.campus.graph.data.bbox);
    await this.map.showTransit(this.campus.transit);
    this.root.status.textContent = "Campus loaded. Buses update every few seconds.";
    // Buses keep moving between GPS fixes: along the paths the arrival model predicts, redrawn every frame.
    const motion = new VehicleMotion(this.campus.transit);
    new LiveFeed(
      (vehicles) => motion.update(vehicles),
      (message) => (this.root.status.textContent = message),
    ).start();
    new ModelFeed(() => this.map.bounds(), (paths) => motion.setPaths(paths)).start();
    window.setInterval(() => {
      if (!document.hidden) void this.map.showVehicles(motion.positions());
    }, settings.frameMs);
    this.bindSearch("from", (hit) => {
      this.from = hit;
      this.drawTrip();
    });
    this.bindSearch("to", (hit) => {
      this.to = hit;
      this.drawTrip();
    });
    document.querySelector("#mode")!.addEventListener("change", () => this.drawTrip());
    document.querySelector("#stop-back")!.addEventListener("click", () => this.closeStop());
  }

  private bindSearch(id: "from" | "to", choose: (endpoint: Endpoint) => void): void {
    const input = document.querySelector<HTMLInputElement>(`#${id}`)!;
    const list = document.querySelector<HTMLUListElement>(`#${id}-hits`)!;
    input.addEventListener("input", () => {
      const hits = input.value.trim() ? this.campus.search.search(input.value, { limit: 6 }) : [];
      list.hidden = hits.length === 0;
      list.replaceChildren(...hits.map((hit) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label(hit);
        button.onclick = () => {
          input.value = label(hit);
          list.hidden = true;
          choose(endpoint(hit));
        };
        item.append(button);
        return item;
      }));
    });
  }

  private drawTrip(): void {
    if (!this.from || !this.to) return;
    const mode = (document.querySelector<HTMLSelectElement>("#mode")!.value || "walk") as ModeId;
    const planned = this.planner.plan(this.from, this.to, mode);
    this.root.trip.textContent = planned.note;
    // The bus and trolley lines this trip rides: shown with the trip, hidden otherwise.
    const { patterns } = this.campus.transit.data;
    const lines = (planned.route?.legs ?? []).flatMap((leg) =>
      leg.mode === "bus" ? [{ color: leg.route.color, route: patterns[leg.pattern]?.shape ?? [], ridden: leg.coordinates }] : [],
    );
    void this.map.showTrip(planned.route?.coordinates ?? [], lines);
    this.map.fitTrip(planned.route?.coordinates ?? []);
  }

  private openStop(id: string): void {
    const stop = this.campus.transit.data.stops.find((s) => s.id === id);
    if (!stop) return;
    const cluster = sameNameCluster(this.campus.transit.data.stops, stop);
    const ids = (cluster.length ? cluster : [stop]).map((s) => s.id);
    this.routeFilter = null;
    this.root.stop.hidden = false;
    document.querySelector("#stop-name")!.textContent = stop.name;
    this.renderStop(ids);
    this.map.focus(stop.lngLat);
  }

  private renderStop(ids: string[]): void {
    const lines = linesAtStops(this.campus.transit, ids);
    const box = document.querySelector("#stop-lines")!;
    box.replaceChildren();
    for (const line of lines) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `line ${this.routeFilter === line.route.id ? "on" : ""}`;
      button.style.setProperty("--c", line.route.color);
      button.textContent = line.route.mode === "trolley" ? `${line.route.short} Line` : line.route.short;
      button.onclick = () => {
        this.routeFilter = this.routeFilter === line.route.id ? null : line.route.id;
        this.renderStop(ids);
      };
      box.append(button);
    }
    const shapes = shapesAtStops(this.campus.transit, ids).filter((s) => !this.routeFilter || s.route.id === this.routeFilter);
    void this.map.showHighlight(shapes.map((s) => ({ color: s.route.color, coordinates: s.shape })));
    const times = document.querySelector("#stop-times")!;
    const arrivals = arrivalsAtStops(this.campus.transit, ids, new Date(), 12)
      .filter((a) => !this.routeFilter || a.route.id === this.routeFilter);
    times.replaceChildren(...arrivals.map((a) => {
      const item = document.createElement("li");
      item.textContent = `${a.route.short} ${a.headsign} · ${a.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      return item;
    }));
  }

  private openVehicle(vehicle: LiveVehicle): void {
    const shapes = this.campus.transit.data.patterns.flatMap((pattern) => {
      const route = this.campus.transit.data.routes[pattern.route];
      if (!route || route.short !== vehicle.route || pattern.shape.length < 2) return [];
      return [{ color: vehicle.color, coordinates: pattern.shape }];
    });
    this.root.stop.hidden = true;
    void this.map.showHighlight(shapes);
    this.root.trip.textContent = `${vehicle.mode === "trolley" ? vehicle.line : `Route ${vehicle.line}`} · last GPS ${age(vehicle.fixAt)}`;
    this.map.focus(vehicle.lngLat);
  }

  private closeStop(): void {
    this.root.stop.hidden = true;
    void this.map.showHighlight([]);
  }
}

function label(hit: SearchHit): string {
  if (hit.kind === "building") return hit.building.name;
  if (hit.kind === "place") return hit.place.name;
  if (hit.kind === "room") return `${hit.building.name} ${hit.room}`;
  if (hit.kind === "class") return hit.meeting.course;
  return hit.course.title;
}

function endpoint(hit: SearchHit): Endpoint {
  if (hit.kind === "place") return { kind: "place", place: hit.place };
  if (hit.kind === "building") return { kind: "building", building: hit.building };
  if (hit.kind === "room") return { kind: "building", building: hit.building, room: hit.room };
  if (hit.kind === "class") return { kind: "building", building: hit.building };
  return { kind: "building", building: hit.building, room: hit.room };
}

function age(fixAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - fixAt) / 1000));
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
}
