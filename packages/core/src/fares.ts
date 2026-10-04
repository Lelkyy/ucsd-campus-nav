import type { Route } from "./route.ts";
import type { FeedFare } from "./transit.ts";

export interface TripFare {
  /** What you'd pay, given whether you have a U-Pass. */
  total: number;
  /** What it costs without a U-Pass. */
  withoutPass: number;
  /** Systems you pay on, e.g. ["MTS"]. */
  paidOn: string[];
  /** The U-Pass covers everything you'd otherwise pay for. */
  coveredByPass: boolean;
}

/**
 * Fare for a route's transit legs. A paid fare covers further rides on the same
 * system within its transfer window (MTS: 2 hours with PRONTO); campus shuttles
 * are free; the UC San Diego U-Pass makes MTS free. Null when there's no transit.
 */
export function tripFare(route: Route, fares: Record<string, FeedFare>, opts: { upass: boolean }): TripFare | null {
  const rides = route.legs.filter((l) => l.mode === "bus");
  if (rides.length === 0) return null;
  const paidAt = new Map<string, number>();
  let withoutPass = 0;
  let total = 0;
  const paidOn = new Set<string>();
  for (const ride of rides) {
    const fare = fares[ride.route.feed];
    if (!fare || fare.oneWay <= 0) continue;
    const last = paidAt.get(ride.route.feed);
    const window = (fare.transferMinutes ?? 0) * 60_000;
    if (last !== undefined && ride.departs.getTime() - last <= window) continue;
    paidAt.set(ride.route.feed, ride.departs.getTime());
    withoutPass += fare.oneWay;
    paidOn.add(fare.name);
    if (!(opts.upass && fare.upassFree)) total += fare.oneWay;
  }
  return { total, withoutPass, paidOn: [...paidOn], coveredByPass: withoutPass > 0 && total === 0 };
}

export function formatFare(usd: number): string {
  return usd === 0 ? "Free" : `$${usd.toFixed(2)}`;
}
