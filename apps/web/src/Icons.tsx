import type { ReactNode, SVGProps } from "react";

/** Small line icons drawn on a 24px grid; they inherit the text color. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const WalkIcon = () => (
  <Icon>
    <circle cx="13" cy="4" r="1.8" />
    <path d="M10.5 21l2-6.5L15 17v4" />
    <path d="M12.5 14.5l1-6-3.5 1.5-1.5 3.5" />
    <path d="M13.5 8.5l1.5 3 3 1" />
  </Icon>
);

export const StepFreeIcon = () => (
  <Icon>
    <circle cx="10" cy="4" r="1.8" />
    <path d="M10 7.5v6h5l2.5 5.5" />
    <path d="M10 10h4" />
    <path d="M7.2 11.5a5.5 5.5 0 1 0 7.6 6.7" />
  </Icon>
);

export const BikeIcon = () => (
  <Icon>
    <circle cx="5.5" cy="16.5" r="3.5" />
    <circle cx="18.5" cy="16.5" r="3.5" />
    <path d="M5.5 16.5l4-7.5h6l3 7.5" />
    <path d="M9.5 9l3.5 7.5 2.5-7.5" />
    <path d="M8 6h3" />
  </Icon>
);

export const BusIcon = () => (
  <Icon>
    <rect x="4.5" y="3" width="15" height="15" rx="2.5" />
    <path d="M4.5 11h15" />
    <path d="M8 18v2.5M16 18v2.5" />
    <circle cx="8.5" cy="14.5" r=".6" fill="currentColor" />
    <circle cx="15.5" cy="14.5" r=".6" fill="currentColor" />
  </Icon>
);

export const SwapIcon = () => (
  <Icon>
    <path d="M7 4v16M7 4L3.5 7.5M7 4l3.5 3.5" />
    <path d="M17 20V4M17 20l-3.5-3.5M17 20l3.5-3.5" />
  </Icon>
);

export const LocateIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
    <circle cx="12" cy="12" r="7" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon width="16" height="16">
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const SatelliteIcon = () => (
  <Icon width="18" height="18">
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </Icon>
);

export const PathsIcon = () => (
  <Icon width="18" height="18">
    <circle cx="6" cy="18" r="2" />
    <circle cx="18" cy="6" r="2" />
    <path d="M7.5 16.5C12 12 8 9 12 6.5c1.5-1 3-.5 4.5-.5" />
  </Icon>
);

export const ClockIcon = () => (
  <Icon width="16" height="16">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const ChevronIcon = ({ up }: { up?: boolean }) => (
  <Icon width="18" height="18">
    <path d={up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
  </Icon>
);

export const TrolleyIcon = () => (
  <Icon>
    <path d="M9 2.5h6M12 2.5V5" />
    <rect x="5.5" y="5" width="13" height="13" rx="3" />
    <path d="M5.5 11.5h13" />
    <path d="M8.5 21l1.5-3M15.5 21L14 18" />
    <circle cx="9" cy="15" r=".6" fill="currentColor" />
    <circle cx="15" cy="15" r=".6" fill="currentColor" />
  </Icon>
);

export const BuildingIcon = () => (
  <Icon width="18" height="18">
    <path d="M4 21V5.5L12 3l8 2.5V21" />
    <path d="M9 21v-4h6v4M8 8h1M12 8h1M16 8h-1M8 12h1M12 12h1M16 12h-1" />
  </Icon>
);

export const DoorIcon = () => (
  <Icon width="18" height="18">
    <path d="M5 21h14M7 21V3.5h10V21" />
    <circle cx="14" cy="12.5" r=".7" fill="currentColor" />
  </Icon>
);

export const BookIcon = () => (
  <Icon width="18" height="18">
    <path d="M4.5 5.5c2.5-1.3 5-1.3 7.5 0v14c-2.5-1.3-5-1.3-7.5 0z" />
    <path d="M19.5 5.5c-2.5-1.3-5-1.3-7.5 0v14c2.5-1.3 5-1.3 7.5 0z" />
  </Icon>
);

export const PinIcon = () => (
  <Icon width="18" height="18">
    <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.3" />
  </Icon>
);

export const StarIcon = () => (
  <Icon width="16" height="16">
    <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" />
  </Icon>
);

export const FlagIcon = () => (
  <Icon width="16" height="16">
    <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
  </Icon>
);

export const HomeIcon = () => (
  <Icon width="18" height="18">
    <path d="M3.5 11L12 4l8.5 7" />
    <path d="M6 9.5V20h12V9.5M10 20v-5h4v5" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon width="18" height="18">
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </Icon>
);
