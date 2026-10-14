import { freeVehicles, type SharedBike } from "@campus/core";

/**
 * Spin's public GBFS feeds for San Diego (the UCSD fleet), listed in its index at
 * https://mds.bird.co/gbfs/v2/public/provider/spin/san_diego/gbfs.json. The index itself
 * doesn't allow browsers to read it; these feeds do.
 */
const FEED = "https://gbfs.spin.pm/api/gbfs/v2_3/san_diego";
/** How often the feed updates (its `ttl`). */
export const SPIN_REFRESH_MS = 60_000;

/** Spin e-bikes and scooters free to ride right now. */
export async function fetchSpinVehicles(): Promise<SharedBike[]> {
  const get = async (name: string) => {
    const res = await fetch(`${FEED}/${name}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Spin ${name}: HTTP ${res.status}`);
    return res.json();
  };
  const [types, status] = await Promise.all([get("vehicle_types"), get("free_bike_status")]);
  return freeVehicles(types, status);
}
