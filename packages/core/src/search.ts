import type { Building, Place } from "./types.ts";

/**
 * Rank buildings for a search box. Understands schedule-style input such as
 * "CENTR 115" or "wlh 2001" by ignoring a trailing room number.
 */
export function searchBuildings(buildings: Building[], query: string, limit = 8): Building[] {
  const q = normalize(query.replace(/\s+[a-z]?\d+[a-z]?$/i, ""));
  if (!q) return [];
  const scored: { b: Building; score: number }[] = [];
  for (const b of buildings) {
    const name = normalize(b.name);
    const aliases = b.aliases.map(normalize);
    let score = 0;
    if (aliases.includes(q)) score = 100;
    else if (name === q) score = 90;
    else if (name.startsWith(q)) score = 70;
    else if (aliases.some((a) => a.startsWith(q))) score = 60;
    else if (name.split(" ").some((w) => w.startsWith(q))) score = 50;
    else if (name.includes(q)) score = 30;
    else if (q.split(" ").every((w) => name.includes(w))) score = 20;
    if (score > 0) scored.push({ b, score });
  }
  scored.sort((x, y) => y.score - x.score || x.b.name.length - y.b.name.length);
  return scored.slice(0, limit).map((s) => s.b);
}

/** Pull a room number off schedule-style input: "CENTR 115" -> "115". */
export function parseRoom(query: string): string | undefined {
  return query.match(/\s+([a-z]?\d+[a-z]?)$/i)?.[1];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Rank places (student names, stops, saved spots) for a search box. */
export function searchPlaces(places: Place[], query: string, limit = 5): Place[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { p: Place; score: number }[] = [];
  for (const p of places) {
    const names = [p.name, ...p.aliases].map(normalize);
    let score = 0;
    if (names.includes(q)) score = 100;
    else if (names.some((n) => n.startsWith(q))) score = 70;
    else if (names.some((n) => n.split(" ").some((w) => w.startsWith(q)))) score = 50;
    else if (names.some((n) => n.includes(q))) score = 30;
    // Your own names and student names first, then stops.
    if (score > 0) scored.push({ p, score: score + (p.kind === "saved" ? 15 : p.kind === "lingo" ? 10 : 0) });
  }
  scored.sort((x, y) => y.score - x.score || x.p.name.length - y.p.name.length);
  return scored.slice(0, limit).map((s) => s.p);
}
