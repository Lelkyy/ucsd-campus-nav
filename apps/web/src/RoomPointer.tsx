import { floorPhrase, type Building, type FloorGuess } from "@campus/core";
import { useEffect, useRef } from "react";

interface Props {
  building: Building;
  room: string;
  floor?: FloorGuess;
  /** Reports the card's height, so the map's buttons can sit below it. */
  onHeight?: (px: number) => void;
}

/** Where the room is, roughly, kept in the corner of the map: "It's on the second floor." */
export function RoomPointer({ building, room, floor, onHeight }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onHeight) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      onHeight(0);
    };
  }, [onHeight]);

  const code = building.aliases.find((a) => /^[A-Z0-9-]{2,6}$/.test(a));
  return (
    <div ref={ref} className="room-pointer" role="status" aria-label={`Where ${room} is`}>
      <strong>
        {code ? `${code} ` : ""}
        {room}
      </strong>
      <span className="muted pointer-building">{building.name}</span>
      <span className="pointer-floor">{floor ? `It's ${floorPhrase(floor)}.` : `Look for ${room} once inside.`}</span>
      {floor?.source === "number" && <span className="muted pointer-note">Going by the room number</span>}
    </div>
  );
}
