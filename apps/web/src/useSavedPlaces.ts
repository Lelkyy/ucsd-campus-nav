import type { LngLat, Place } from "@campus/core";
import { useCallback, useEffect, useState } from "react";
import { REPORT_EMAIL } from "./config.ts";
import { storage } from "./data.ts";

const KEY = "campus-nav:places";
/** Your home is a saved place with this id (one at most). */
export const HOME_ID = "saved-home";

/** Your own names for places ("my bike rack", "Muir Field drop-off"), saved in this browser. */
export function useSavedPlaces() {
  const [places, setPlaces] = useState<Place[]>(() => storage.get<Place[]>(KEY, []));
  useEffect(() => storage.set(KEY, places), [places]);

  const add = useCallback((name: string, points: LngLat[], note?: string): Place => {
    const place: Place = { id: `saved-${crypto.randomUUID()}`, name: name.trim(), aliases: [], points, kind: "saved", note };
    setPlaces((cur) => [...cur.filter((p) => p.name.toLowerCase() !== place.name.toLowerCase()), place]);
    return place;
  }, []);
  const remove = useCallback((id: string) => setPlaces((cur) => cur.filter((p) => p.id !== id)), []);
  /** Save (or move) your home; it's listed first and found by searching "home". */
  const setHome = useCallback((points: LngLat[]): Place => {
    const home: Place = { id: HOME_ID, name: "Home", aliases: ["My home", "House", "Apartment"], points, kind: "saved" };
    setPlaces((cur) => [home, ...cur.filter((p) => p.id !== HOME_ID)]);
    return home;
  }, []);
  const home = places.find((p) => p.id === HOME_ID) ?? null;

  return { places, add, remove, home, setHome };
}

/** Email link suggesting a place name for everyone (maintainers add it to data/places.json). */
export function suggestPlaceHref(name: string, at: LngLat, note?: string): string {
  const [lon, lat] = at.map((v) => v.toFixed(6));
  const body = [
    `Place name: ${name}`,
    `Where: ${lat}, ${lon}`,
    `Map: https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}`,
    note ? `Note: ${note}` : "",
    "",
    "Suggested from Campus Nav. Maintainers: add to data/places.json.",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(`Campus Nav place name: ${name}`)}&body=${encodeURIComponent(body)}`;
}
