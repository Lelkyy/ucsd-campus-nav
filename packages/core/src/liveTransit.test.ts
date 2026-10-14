import { describe, expect, it } from "vitest";
import { liveVehicles } from "./liveTransit.ts";

describe("live trolleys and buses (OneBusAway vehicles-for-agency)", () => {
  const response = {
    data: {
      list: [
        {
          vehicleId: "MTS_4012",
          tripStatus: {
            activeTripId: "MTS_t1",
            position: { lat: 32.8711, lon: -117.2235 },
            orientation: 90, // north, in OneBusAway's counterclockwise-from-east degrees
            nextStop: "MTS_s1",
            nextStopTimeOffset: 180,
            predicted: true,
          },
        },
        { vehicleId: "MTS_bus", tripStatus: { activeTripId: "MTS_t2", position: { lat: 32.88, lon: -117.24 } } },
        { vehicleId: "MTS_coaster", tripStatus: { activeTripId: "MTS_t3", position: { lat: 32.9, lon: -117.25 } } },
        { vehicleId: "MTS_idle", tripStatus: { position: { lat: 32.7, lon: -117.1 } } },
      ],
      references: {
        trips: [
          { id: "MTS_t1", routeId: "MTS_510", tripHeadsign: "UTC" },
          { id: "MTS_t2", routeId: "MTS_201", tripHeadsign: "UTC" },
          { id: "MTS_t3", routeId: "NCTD_398", tripHeadsign: "Oceanside" },
        ],
        routes: [
          { id: "MTS_510", shortName: "510", longName: "Blue Line", type: 0, color: "0F6BAF" },
          { id: "MTS_201", shortName: "201", type: 3 },
          { id: "NCTD_398", shortName: "398", type: 2 },
        ],
        stops: [{ id: "MTS_s1", name: "Nobel Drive" }],
      },
    },
  };

  it("keeps trolleys and buses (not trains or vehicles off a trip), with line, direction and next stop", () => {
    expect(liveVehicles(response)).toEqual([
      {
        id: "MTS_4012",
        mode: "trolley",
        route: "510",
        lngLat: [-117.2235, 32.8711],
        heading: 0,
        line: "Blue Line",
        color: "#0F6BAF",
        headsign: "UTC",
        nextStop: { name: "Nobel Drive", inSeconds: 180 },
        predicted: true,
      },
      {
        id: "MTS_bus",
        mode: "bus",
        route: "201",
        lngLat: [-117.24, 32.88],
        heading: undefined,
        line: "201",
        color: "#4A6497",
        headsign: "UTC",
        nextStop: undefined,
        predicted: false,
      },
    ]);
  });

  it("turns OneBusAway's orientation into a compass heading", () => {
    const at = (orientation: number) =>
      liveVehicles({ data: { ...response.data, list: [{ ...response.data.list[0], tripStatus: { ...response.data.list[0].tripStatus, orientation } }] } })[0].heading;
    expect(at(0)).toBe(90); // east
    expect(at(180)).toBe(270); // west
    expect(at(270)).toBe(180); // south
  });
});
