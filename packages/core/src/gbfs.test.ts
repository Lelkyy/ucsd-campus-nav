import { describe, expect, it } from "vitest";
import { freeEbikes } from "./gbfs.ts";

describe("GBFS e-bikes", () => {
  const types = {
    data: {
      vehicle_types: [
        { vehicle_type_id: "scooter", form_factor: "scooter", propulsion_type: "electric" },
        { vehicle_type_id: "ebike", form_factor: "bicycle", propulsion_type: "electric_assist" },
        { vehicle_type_id: "pedal", form_factor: "bicycle", propulsion_type: "human" },
      ],
    },
  };
  const bike = (id: string, type: string, extra = {}) => ({ bike_id: id, lat: 32.88, lon: -117.24, vehicle_type_id: type, ...extra });

  it("keeps e-bikes free to ride, not scooters, pedal bikes, reserved or broken ones", () => {
    const status = {
      data: {
        bikes: [
          bike("a", "ebike", { current_fuel_percent: 0.7, current_range_meters: 40000 }),
          bike("b", "scooter"),
          bike("c", "pedal"),
          bike("d", "ebike", { is_reserved: true }),
          bike("e", "ebike", { is_disabled: 1 }),
        ],
      },
    };
    expect(freeEbikes(types, status)).toEqual([{ id: "a", lngLat: [-117.24, 32.88], battery: 0.7, rangeMeters: 40000 }]);
  });
});
