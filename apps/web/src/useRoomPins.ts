import type { LngLat } from "@campus/core";
import { useCallback, useEffect, useState } from "react";
import { REPORT_EMAIL } from "./config.ts";
import { storage } from "./data.ts";

const KEY = "campus-nav:room-pins";

/** Where a room is, as an OSM-style level (0 = ground floor). */
export interface RoomPin {
  at: LngLat;
  level: string;
  note?: string;
}

/** Rooms you've pinned yourself ("WLH 2001" -> spot + floor), saved in this browser. */
export function useRoomPins() {
  const [pins, setPins] = useState<Record<string, RoomPin>>(() => storage.get(KEY, {}));
  useEffect(() => storage.set(KEY, pins), [pins]);
  const save = useCallback((key: string, pin: RoomPin) => setPins((cur) => ({ ...cur, [key]: pin })), []);
  const remove = useCallback(
    (key: string) =>
      setPins((cur) => {
        const next = { ...cur };
        delete next[key];
        return next;
      }),
    [],
  );
  return { pins, save, remove };
}

/** Email the pin to the map team, in the format data/room-locations.json uses. */
export function suggestRoomHref(key: string, pin: RoomPin): string {
  const [lon, lat] = pin.at.map((v) => Number(v.toFixed(6)));
  const entry = JSON.stringify({ [key]: { at: [lon, lat], level: pin.level, ...(pin.note ? { note: pin.note } : {}) } });
  const body = [
    `Room: ${key}`,
    `Where: ${lat}, ${lon} (level ${pin.level}; 0 = ground floor)`,
    `Map: https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=20/${lat}/${lon}`,
    pin.note ? `Note: ${pin.note}` : "",
    "",
    "For data/room-locations.json:",
    entry,
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(`Campus Nav room location: ${key}`)}&body=${encodeURIComponent(body)}`;
}
