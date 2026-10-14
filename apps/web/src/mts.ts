import { liveVehicles, type LiveVehicle } from "@campus/core";

/**
 * MTS real-time data (https://www.sdmts.com/business-center/app-developers/real-time-data),
 * through its OneBusAway API. It needs a key from MTS's request form, set as VITE_MTS_KEY
 * (e.g. in apps/web/.env.local, which stays out of git). Use is under MTS's developer license
 * agreement.
 */
const KEY: string | undefined = import.meta.env.VITE_MTS_KEY || undefined;
export const MTS_LIVE = !!KEY;
/** How often to ask again while trolleys or buses are shown (MTS vehicles report every ~30 s). */
export const LIVE_REFRESH_MS = 20_000;

/** Every trolley and bus running now, and when the answer is from (times in it count from then). */
export async function fetchLiveVehicles(): Promise<{ vehicles: LiveVehicle[]; at: number }> {
  if (!KEY) throw new Error("No MTS real-time key (VITE_MTS_KEY)");
  const url = `https://realtime.sdmts.com/api/api/where/vehicles-for-agency/MTS.json?key=${encodeURIComponent(KEY)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`MTS real-time: HTTP ${res.status}`);
  const text = await res.text();
  // Without a valid key the API answers with an empty body.
  if (!text) throw new Error("MTS real-time: empty answer (is the key right?)");
  const json = JSON.parse(text) as { currentTime?: number; code?: number; text?: string };
  if (json.code !== undefined && json.code !== 200) throw new Error(`MTS real-time: ${json.text ?? json.code}`);
  return { vehicles: liveVehicles(json as Parameters<typeof liveVehicles>[0]), at: json.currentTime ?? Date.now() };
}
