import type { Maneuver } from "@campus/core";

const ANGLE: Partial<Record<Maneuver, number>> = {
  depart: 0,
  straight: 0,
  "slight-right": 45,
  right: 90,
  "sharp-right": 135,
  "slight-left": -45,
  left: -90,
  "sharp-left": -135,
};

/** Arrow (or symbol) for a turn-by-turn instruction. */
export function ManeuverIcon({ maneuver, size = 28 }: { maneuver: Maneuver; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (maneuver === "arrive") {
    return (
      <svg {...common}>
        <path d="M6 21V4" />
        <path d="M6 4h11l-2.5 4L17 12H6" />
      </svg>
    );
  }
  if (maneuver === "stairs") {
    return (
      <svg {...common}>
        <path d="M3 20h5v-5h5v-5h5V5h3" />
      </svg>
    );
  }
  if (maneuver === "board" || maneuver === "alight") {
    return (
      <svg {...common}>
        <rect x="4.5" y="3" width="15" height="15" rx="2.5" />
        <path d="M4.5 11h15M8 18v2.5M16 18v2.5" />
      </svg>
    );
  }
  if (maneuver === "walk-bike" || maneuver === "ride-bike") {
    return (
      <svg {...common}>
        <circle cx="5.5" cy="16.5" r="3.5" />
        <circle cx="18.5" cy="16.5" r="3.5" />
        <path d="M5.5 16.5l4-7.5h6l3 7.5M9.5 9l3.5 7.5 2.5-7.5" />
      </svg>
    );
  }
  const angle = ANGLE[maneuver] ?? 0;
  // A stem coming from below, bending toward the turn direction.
  return (
    <svg {...common}>
      <g transform={`rotate(${angle / 2} 12 14)`}>
        <path d="M12 21v-7" />
        <g transform={`rotate(${angle / 2} 12 14)`}>
          <path d="M12 14V4M7.5 8.5L12 4l4.5 4.5" />
        </g>
      </g>
    </svg>
  );
}
