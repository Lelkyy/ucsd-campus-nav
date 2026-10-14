import type { LngLat } from "./types.ts";

/**
 * Shared vehicles from a GBFS feed (General Bikeshare Feed Specification, v2.x): the e-bikes
 * free to ride now, from `vehicle_types` and `free_bike_status`.
 */
export interface SharedBike {
  id: string;
  lngLat: LngLat;
  /** Battery charge, 0–1, when the feed says. */
  battery?: number;
  /** How far it can go on its charge, in meters, when the feed says. */
  rangeMeters?: number;
}

interface GbfsVehicleTypes {
  data: { vehicle_types: { vehicle_type_id: string; form_factor: string; propulsion_type?: string }[] };
}
interface GbfsFreeBikeStatus {
  data: {
    bikes: {
      bike_id: string;
      lat: number;
      lon: number;
      is_disabled?: boolean | number;
      is_reserved?: boolean | number;
      vehicle_type_id?: string;
      current_fuel_percent?: number;
      current_range_meters?: number;
    }[];
  };
}

/** The e-bikes (bicycles with any motor; not scooters) you could ride now: not reserved, not out of order. */
export function freeEbikes(types: GbfsVehicleTypes, status: GbfsFreeBikeStatus): SharedBike[] {
  const ebikeTypes = new Set(
    types.data.vehicle_types.filter((t) => t.form_factor === "bicycle" && t.propulsion_type !== "human").map((t) => t.vehicle_type_id),
  );
  return status.data.bikes
    .filter((b) => b.vehicle_type_id && ebikeTypes.has(b.vehicle_type_id) && !b.is_disabled && !b.is_reserved)
    .map((b) => ({
      id: b.bike_id,
      lngLat: [b.lon, b.lat] as LngLat,
      battery: b.current_fuel_percent,
      rangeMeters: b.current_range_meters,
    }));
}
