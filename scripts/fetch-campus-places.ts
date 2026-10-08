/**
 * Points of interest from UC San Diego's public campus map (the "Places" panel
 * of the ArcGIS campus map): restrooms, food, water, bike racks, parking...
 * Writes apps/web/public/data/campus-places.json, grouped into the categories
 * the app shows. Run with `npm run fetch:places`.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps/web/public/data/campus-places.json");
const LAYER = "https://services9.arcgis.com/mXNwDpiENQiMIzRv/arcgis/rest/services/Campus_Points_Of_Interest_-_Public/FeatureServer/1";

/** The app's categories, each a set of UCSD subclasses (by name, whatever class they're filed under). */
const CATEGORIES: { id: string; label: string; color: string; subclasses: string[] }[] = [
  {
    id: "food",
    label: "Food & drink",
    color: "#D9732B",
    subclasses: ["Dining Halls", "Cafes and Restaurants", "Coffee", "Markets"],
  },
  { id: "vending", label: "Vending machines", color: "#8A5A9E", subclasses: ["Vending Machines"] },
  {
    id: "restrooms",
    label: "Restrooms",
    color: "#2B7BB9",
    subclasses: ["Public", "Gender Inclusive", "Lactation Rooms", "Baby Changing Stations", "Showers", "Period Product Dispensers"],
  },
  { id: "water", label: "Water refill", color: "#1F8F8A", subclasses: ["Hydration"] },
  {
    id: "study",
    label: "Study & print",
    color: "#7A4FB0",
    subclasses: ["Libraries", "Computer Labs", "Lounges", "Printers and Print Services", "Charging Stations", "Book Return"],
  },
  {
    id: "health",
    label: "Health & safety",
    color: "#C2415B",
    subclasses: [
      "Student Health & Well-Being",
      "Medical Clinics",
      "Hospitals",
      "Emergency Care",
      "AED/Trauma Kits",
      "Call Boxes",
      "Police",
    ],
  },
  {
    id: "services",
    label: "Services",
    color: "#5D6B50",
    subclasses: ["ATMs", "Mail Boxes and Services", "Laundry", "Student Services", "Career Services", "Information", "Kiosks", "Retail"],
  },
  {
    id: "bikes",
    label: "Bikes & scooters",
    color: "#2F7A3A",
    subclasses: ["Bicycle Racks", "Bicycle Enclosures", "SPIN Hubs"],
  },
  {
    id: "parking",
    label: "Parking & charging",
    color: "#4A6497",
    subclasses: [
      "Parking Structures",
      "Parking Lots",
      "Parking Pay Stations",
      "Parking Offices",
      "Level 2 Chargers",
      "DC Fast Chargers",
      "Passenger Loading Zones",
    ],
  },
  {
    id: "fun",
    label: "Rec, art & gardens",
    color: "#B7891A",
    subclasses: [
      "Recreation Facilities",
      "Athletic Facilities",
      "Theatres",
      "Stuart Collection",
      "Art Installations",
      "Landmarks",
      "Gardens",
    ],
  },
];

/** What to call a place UCSD left unnamed (most water, restroom and bike points). */
const KIND_NAMES: Record<string, string> = {
  Hydration: "Water refill station",
  Public: "Restroom",
  "Gender Inclusive": "All-gender restroom",
  "Lactation Rooms": "Lactation room",
  "Baby Changing Stations": "Baby changing station",
  Showers: "Showers",
  "Period Product Dispensers": "Period products",
  "Bicycle Racks": "Bike racks",
  "Bicycle Enclosures": "Bike enclosure",
  "SPIN Hubs": "Scooter and bike share hub",
  "AED/Trauma Kits": "AED and trauma kit",
  "Call Boxes": "Emergency call box",
  "Vending Machines": "Vending machines",
  ATMs: "ATM",
  "Level 2 Chargers": "EV chargers",
  "DC Fast Chargers": "EV fast chargers",
  "Parking Pay Stations": "Parking pay station",
  "Passenger Loading Zones": "Passenger loading zone",
  "Printers and Print Services": "Printing",
  "Charging Stations": "Device charging",
  "Mail Boxes and Services": "Mail",
  Laundry: "Laundry",
  "Computer Labs": "Computer lab",
  Lounges: "Lounge",
};

interface Feature {
  properties: Record<string, string | number | null>;
  geometry: { type: string; coordinates: [number, number] } | null;
}

async function fetchAll(): Promise<Feature[]> {
  const out: Feature[] = [];
  for (let offset = 0; ; offset += 1000) {
    const url =
      `${LAYER}/query?where=1%3D1&outFields=Class,Subclass,UpdatedName,FacilityLongName&returnGeometry=true&outSR=4326` +
      `&orderByFields=OBJECTID&resultOffset=${offset}&resultRecordCount=1000&f=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} from the UCSD places layer`);
    const page = (await res.json()) as { features: Feature[] };
    out.push(...page.features);
    if (page.features.length < 1000) return out;
  }
}

const features = await fetchAll();
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const seen = new Set<string>();
const points: [number, number, number, string, string, string][] = [];
const skipped = new Map<string, number>();
for (const f of features) {
  if (f.geometry?.type !== "Point") continue;
  const sub = String(f.properties.Subclass ?? "");
  const cat = CATEGORIES.findIndex((c) => c.subclasses.includes(sub));
  if (cat < 0) {
    skipped.set(sub, (skipped.get(sub) ?? 0) + 1);
    continue;
  }
  const [lng, lat] = f.geometry.coordinates;
  const building = String(f.properties.FacilityLongName ?? "").trim();
  const name = String(f.properties.UpdatedName ?? "").trim() || KIND_NAMES[sub] || building || sub;
  // The same place filed under two classes (Coffee as food and as a service) once.
  const key = `${round(lng)},${round(lat)},${cat},${name}`;
  if (seen.has(key)) continue;
  seen.add(key);
  points.push([round(lng), round(lat), cat, name, sub, building === name ? "" : building]);
}

writeFileSync(
  OUT,
  JSON.stringify({
    source: "UC San Diego Campus Map (Campus Points Of Interest - Public)",
    fetchedAt: new Date().toISOString().slice(0, 10),
    categories: CATEGORIES.map(({ id, label, color }) => ({ id, label, color })),
    points,
  }),
);
const counts = CATEGORIES.map((c, i) => `${c.label} ${points.filter((p) => p[2] === i).length}`).join(", ");
console.log(`${points.length} places of ${features.length} (${counts})`);
console.log(`left out: ${[...skipped].map(([s, n]) => `${s || "(none)"} ${n}`).join(", ")}`);
