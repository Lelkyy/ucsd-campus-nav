import {
  CampusGraph,
  TransitNetwork,
  type Building,
  type GraphData,
  type IndoorData,
  type PlacesData,
  type SectionsData,
  type TransitData,
} from "@campus/core";

export interface CampusData {
  graph: CampusGraph;
  buildings: Building[];
  buildingById: Map<string, Building>;
  /** Schedule building code ("WLH") -> building. */
  buildingByCode: Map<string, Building>;
  transit: TransitNetwork;
  /** Current term's course sections, when the (private) schedule data has been built. */
  sections: SectionsData | null;
  /** Rooms mapped indoors, by building id. */
  indoor: IndoorData;
  /** Student place names, shuttle stops and building tips. */
  places: PlacesData;
}

/** Load the prebuilt graph, buildings, shuttles and sections. `bust` forces a re-fetch after an edit. */
export async function loadCampus(bust = false): Promise<CampusData> {
  const q = bust ? `?t=${Date.now()}` : "";
  const [graphData, buildings, transitData, sections, indoor, places] = await Promise.all([
    fetchJson<GraphData>(`/data/graph.json${q}`),
    fetchJson<Building[]>(`/data/buildings.json${q}`),
    fetchJson<TransitData>(`/data/transit.json${q}`),
    fetchJson<SectionsData>(`/data/sections.json${q}`).catch(() => null),
    fetchJson<IndoorData>(`/data/indoor.json${q}`).catch(() => ({})),
    fetchJson<PlacesData>(`/data/places.json${q}`).catch(() => ({ places: [], tips: {} })),
  ]);
  const graph = new CampusGraph(graphData);
  const buildingByCode = new Map<string, Building>();
  for (const b of buildings) for (const a of b.aliases) if (/^[A-Z0-9-]{2,6}$/.test(a)) buildingByCode.set(a, b);
  // The current term's rooms come with the (private) sections file, not buildings.json.
  for (const course of sections?.courses ?? []) {
    for (const [, , , , , , , code, room] of course.meetings) {
      const b = code && room ? buildingByCode.get(code) : undefined;
      if (b && !b.rooms?.includes(room)) b.rooms = [...(b.rooms ?? []), room];
    }
  }
  return {
    graph,
    buildings,
    buildingById: new Map(buildings.map((b) => [b.id, b])),
    buildingByCode,
    transit: new TransitNetwork(transitData, graph),
    sections,
    indoor,
    places,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}. Run "npm run build:graph" first.`);
  return res.json() as Promise<T>;
}

/** localStorage that never throws (private windows, blocked storage). */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Not persisted; the export button still works.
    }
  },
};
