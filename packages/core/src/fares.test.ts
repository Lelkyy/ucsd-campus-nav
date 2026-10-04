import { describe, expect, it } from "vitest";
import { tripFare } from "./fares.ts";
import type { BusLeg, Route } from "./route.ts";
import type { FeedFare, TransitRoute } from "./transit.ts";

const fares: Record<string, FeedFare> = {
  triton: { name: "Triton Transit", oneWay: 0 },
  mts: { name: "MTS", oneWay: 3, transferMinutes: 120, upassFree: true },
};
const trolley: TransitRoute = { id: "mts:510", short: "Blue", long: "San Ysidro - UTC", color: "#00f", feed: "mts", mode: "trolley" };
const bus: TransitRoute = { id: "mts:30", short: "30", long: "Old Town - UTC", color: "#000", feed: "mts", mode: "bus" };
const shuttle: TransitRoute = { id: "triton:IL", short: "IL", long: "Inside Loop", color: "#fc0", feed: "triton", mode: "shuttle" };

const ride = (route: TransitRoute, h: number, m: number): BusLeg =>
  ({ mode: "bus", route, departs: new Date(2026, 9, 7, h, m), arrives: new Date(2026, 9, 7, h, m + 5) }) as BusLeg;
const routeOf = (...legs: BusLeg[]) => ({ legs }) as unknown as Route;

describe("tripFare", () => {
  it("is null without transit", () => {
    expect(tripFare(routeOf(), fares, { upass: false })).toBeNull();
  });

  it("charges one MTS fare for transfers within 2 hours", () => {
    const f = tripFare(routeOf(ride(trolley, 10, 0), ride(bus, 11, 30)), fares, { upass: false })!;
    expect(f.total).toBe(3);
  });

  it("charges again after the transfer window", () => {
    const f = tripFare(routeOf(ride(trolley, 10, 0), ride(bus, 12, 30)), fares, { upass: false })!;
    expect(f.total).toBe(6);
  });

  it("campus shuttles are free", () => {
    const f = tripFare(routeOf(ride(shuttle, 10, 0)), fares, { upass: false })!;
    expect(f).toMatchObject({ total: 0, withoutPass: 0, coveredByPass: false });
  });

  it("the U-Pass covers MTS", () => {
    const f = tripFare(routeOf(ride(trolley, 10, 0), ride(shuttle, 10, 10)), fares, { upass: true })!;
    expect(f).toMatchObject({ total: 0, withoutPass: 3, coveredByPass: true, paidOn: ["MTS"] });
  });
});
