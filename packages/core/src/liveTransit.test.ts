import { describe, expect, it } from "vitest";
import { alongPath, decodePolyline, decodeTripUpdates, decodeVehiclePositions, liveVehicles, measurePath, pathFrom, pathUntil, pointAlong, tripAhead, type LiveRoute } from "./liveTransit.ts";

/** A protobuf message from fields: [number, varint | string | float32 (as {f}) | negative int32 (as {neg}) | nested fields]. */
type Field = [number, number | string | { f: number } | { neg: number } | Field[]];
function encode(fields: Field[]): number[] {
  const varint = (n: number) => {
    const out: number[] = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return out;
  };
  return fields.flatMap(([f, v]) => {
    if (typeof v === "number") return [...varint(f * 8), ...varint(v)];
    if (typeof v === "object" && "neg" in v) {
      // Two's complement over 64 bits: ten bytes.
      let n = BigInt.asUintN(64, BigInt(v.neg));
      const out: number[] = [];
      do {
        let b = Number(n & 127n);
        n >>= 7n;
        if (n) b |= 0x80;
        out.push(b);
      } while (n);
      return [...varint(f * 8), ...out];
    }
    if (typeof v === "object" && "f" in v) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, v.f, true);
      return [...varint(f * 8 + 5), ...b];
    }
    const body = typeof v === "string" ? [...v].map((c) => c.charCodeAt(0)) : encode(v);
    return [...varint(f * 8 + 2), ...varint(body.length), ...body];
  });
}
const vehicle = (id: string, trip: string, route: string, lat: number, lon: number, at: number): Field => [
  2,
  [
    [1, id],
    [4, [[1, [[1, trip], [5, route]]], [2, [[1, { f: lat }], [2, { f: lon }]]], [5, at], [8, [[1, id], [2, `Bus ${id}`]]]]],
  ],
];

describe("live trolleys and buses (GTFS-realtime vehicle positions)", () => {
  const t = 1_792_098_800;
  const feed = new Uint8Array(
    encode([
      [1, [[1, "2.0"], [3, t]]],
      vehicle("002", "19635450", "510", 32.8711, -117.2235, t - 40),
      vehicle("912", "19629927", "30", 32.875, -117.2388, t - 12),
      vehicle("700", "1", "398", 32.9, -117.25, t - 20),
      vehicle("old", "2", "30", 32.7, -117.1, t - 3 * 3600),
    ]),
  );
  const routes = new Map<string, LiveRoute>([
    // As MTS publishes them: trolleys named by color.
    ["MTS_510", { id: "MTS_510", shortName: "Blue", longName: "San Ysidro - UTC", type: 0, color: "0000FF" }],
    ["MTS_30", { id: "MTS_30", shortName: "30", type: 3 }],
    ["MTS_398", { id: "MTS_398", shortName: "398", type: 2 }],
  ]);

  it("reads each vehicle's GPS fix and when it was taken", () => {
    const { at, fixes } = decodeVehiclePositions(feed);
    expect(at).toBe(t * 1000);
    expect(fixes).toHaveLength(4);
    expect(fixes[0]).toMatchObject({ vehicleId: "002", tripId: "19635450", routeId: "510", at: (t - 40) * 1000 });
    expect(fixes[0].lngLat[0]).toBeCloseTo(-117.2235, 4);
    expect(fixes[0].lngLat[1]).toBeCloseTo(32.8711, 4);
  });

  it("keeps trolleys and buses at their fixes, not trains or vehicles out of service", () => {
    const { fixes } = decodeVehiclePositions(feed);
    const live = liveVehicles(fixes, routes, { now: t * 1000 });
    expect(live.map((v) => [v.id, v.mode, v.line, v.color, v.tripId, v.fixAt])).toEqual([
      ["002", "trolley", "Blue Line", "#0000FF", "MTS_19635450", (t - 40) * 1000],
      ["912", "bus", "30", "#4A6497", "MTS_19629927", (t - 12) * 1000],
    ]);
    expect(live[0].lngLat).toEqual(fixes[0].lngLat);
    expect(live[0].heading).toBeUndefined();
  });

  it("heads the way it moved since its last fix, and keeps that while it stands still", () => {
    const before = new Map([["912", { id: "912", mode: "bus" as const, route: "30", line: "30", color: "", lngLat: [-117.2388, 32.874] as [number, number], fixAt: 0 }]]);
    const { fixes } = decodeVehiclePositions(feed);
    const moved = liveVehicles(fixes, routes, { now: t * 1000, before }).find((v) => v.id === "912")!;
    const north = (h?: number) => Math.min(h!, 360 - h!);
    expect(north(moved.heading)).toBeLessThan(1);
    const still = liveVehicles(fixes, routes, { now: t * 1000, before: new Map([["912", { ...moved, fixAt: 1 }]]) }).find((v) => v.id === "912")!;
    expect(north(still.heading)).toBeLessThan(1);
  });
});

describe("a vehicle's trip ahead", () => {
  it("decodes encoded polylines", () => {
    // Google's documented example.
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it("gives the path from where the vehicle is to the end, and the stops still to come with their times", () => {
    // A straight north-south trip ~333 m long; the vehicle is 150 m along, 2 minutes late.
    const path: [number, number][] = [
      [0, 0],
      [0, 0.001],
      [0, 0.002],
      [0, 0.003],
    ];
    const day = Date.UTC(2026, 9, 14, 7); // midnight in San Diego
    const ahead = tripAhead(
      {
        data: {
          entry: {
            schedule: {
              stopTimes: [
                { stopId: "a", arrivalTime: 36000, distanceAlongTrip: 0 },
                { stopId: "b", arrivalTime: 36060, distanceAlongTrip: 111 },
                { stopId: "c", arrivalTime: 36120, distanceAlongTrip: 222 },
                { stopId: "d", arrivalTime: 36180, distanceAlongTrip: 333 },
              ],
            },
            status: { distanceAlongTrip: 150, scheduleDeviation: 120, serviceDate: day },
          },
          references: {
            stops: ["a", "b", "c", "d"].map((id, k) => ({ id, name: `Stop ${id.toUpperCase()}`, lat: k * 0.001, lon: 0 })),
          },
        },
      },
      path,
    );
    expect(ahead.stops.map((s) => s.name)).toEqual(["Stop C", "Stop D"]);
    expect(ahead.passed.map((s) => s.name)).toEqual(["Stop A", "Stop B"]);
    expect(ahead.stops[0].at).toBe(day + (36120 + 120) * 1000);
    expect(ahead.path[0][1]).toBeCloseTo(150 / 111_195 * 1, 4);
    expect(ahead.path.at(-1)).toEqual([0, 0.003]);
    expect(ahead.path.length).toBe(3);
    expect(ahead.behind[0]).toEqual([0, 0]);
    expect(ahead.behind.at(-1)?.[1]).toBeCloseTo(150 / 111_195 * 1, 4);
    expect(ahead.heading).toBeCloseTo(0, 0);
  });

  it("starts the path ahead at the vehicle's GPS fix, not where MTS reckons it has got to", () => {
    const path: [number, number][] = [
      [0, 0],
      [0, 0.001],
      [0, 0.002],
      [0, 0.003],
    ];
    const details = {
      data: {
        entry: {
          tripId: "t",
          schedule: { stopTimes: [1, 2, 3].map((k) => ({ stopId: `s${k}`, arrivalTime: 100 * k, distanceAlongTrip: 111 * k })) },
          // MTS reckons it's 250 m along; its fix is 100 m along.
          status: { distanceAlongTrip: 250, scheduleDeviation: 0, serviceDate: 0 },
        },
        references: {
          stops: [1, 2, 3].map((k) => ({ id: `s${k}`, name: `Stop ${k}`, lat: k * 0.001, lon: 0 })),
          trips: [{ id: "t", tripHeadsign: "UTC" }],
        },
      },
    };
    const ahead = tripAhead(details, path, [0.00001, 0.0009]);
    expect(ahead.headsign).toBe("UTC");
    expect(ahead.path[0]).toEqual([0.00001, 0.0009]);
    expect(ahead.behind.at(-1)).toEqual([0.00001, 0.0009]);
    expect(ahead.behind[0]).toEqual([0, 0]);
    expect(ahead.stops.map((s) => s.name)).toEqual(["Stop 1", "Stop 2", "Stop 3"]);
    expect(ahead.passed).toEqual([]);
  });
});

describe("moving along a path", () => {
  // North ~111 m, then east ~93 m (at the equator, 0.001° of longitude is ~111 m too).
  const path = measurePath([
    [0, 0],
    [0, 0.001],
    [0.001, 0.001],
  ]);

  it("finds the point a distance along, with the way the path heads there", () => {
    expect(path.length).toBeCloseTo(222.4, 0);
    const halfway = pointAlong(path, 55.6);
    expect(halfway.lngLat[1]).toBeCloseTo(0.0005, 5);
    expect(halfway.heading).toBeCloseTo(0, 0);
    const round = pointAlong(path, 170);
    expect(round.lngLat[1]).toBeCloseTo(0.001, 6);
    expect(round.heading).toBeCloseTo(90, 0);
    // Off the ends: held at them.
    expect(pointAlong(path, 999).lngLat).toEqual([0.001, 0.001]);
    expect(pointAlong(path, -5).lngLat).toEqual([0, 0]);
  });

  it("gives the rest of the path from a point along it (nothing behind)", () => {
    const rest = pathFrom(path, 55.6);
    expect(rest).toHaveLength(3);
    expect(rest[0][1]).toBeCloseTo(0.0005, 5);
    expect(rest.slice(1)).toEqual([
      [0, 0.001],
      [0.001, 0.001],
    ]);
    expect(pathFrom(path, 999)).toHaveLength(1);
  });

  it("gives the trail already covered, up to a point along the path", () => {
    const trail = pathUntil(path, 55.6);
    expect(trail[0]).toEqual([0, 0]);
    expect(trail.at(-1)?.[1]).toBeCloseTo(0.0005, 5);
    expect(pathUntil(path, 0)[0]).toEqual([0, 0]);
    expect(pathUntil(path, 999).at(-1)).toEqual([0.001, 0.001]);
  });

  it("finds how far along the path a stop is, from a point on", () => {
    // A stop just east of the first leg's middle, and one beside the second leg.
    expect(alongPath(path, [0.00002, 0.0005])).toBeCloseTo(55.6, 0);
    expect(alongPath(path, [0.0005, 0.00102])).toBeCloseTo(166.8, 0);
    // Looking only from 120 m on, the first one maps to where the path is nearest after that.
    expect(alongPath(path, [0.00002, 0.0005], 120)).toBeGreaterThanOrEqual(120);
  });
});

describe("MTS's predicted arrivals (GTFS-realtime trip updates)", () => {
  const t = 1_792_790_984;
  const feed = new Uint8Array(
    encode([
      [1, [[1, "1.0"], [3, t]]],
      [
        2,
        [
          [1, "19629352"],
          [
            3,
            [
              [1, [[1, "19629352"], [5, "8"]]],
              [3, [[1, "910"]]],
              [4, t - 47],
              [5, { neg: -120 }],
              [2, [[2, [[2, t + 60]]], [3, [[2, t + 90]]], [4, "94019"]]],
              [2, [[1, 7], [2, [[2, t + 240]]], [4, "11575"]]],
            ],
          ],
        ],
      ],
    ]),
  );

  it("reads each trip's vehicle, route and predicted times at the stops ahead", () => {
    const { at, trips } = decodeTripUpdates(feed);
    expect(at).toBe(t * 1000);
    expect(trips).toEqual([
      {
        tripId: "19629352",
        routeId: "8",
        vehicleId: "910",
        at: (t - 47) * 1000,
        delay: -120,
        stops: [
          { stopId: "94019", arrival: (t + 60) * 1000, departure: (t + 90) * 1000 },
          { stopId: "11575", stopSequence: 7, arrival: (t + 240) * 1000 },
        ],
      },
    ]);
  });
});
