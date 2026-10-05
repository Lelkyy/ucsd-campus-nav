import { floorFromRoom, floorPlan, levelLabel, levelsOf, type Building, type Entrance, type IndoorRoom } from "@campus/core";
import { useEffect, useRef } from "react";
import { fitProjection } from "./planProjection.ts";

const W = 168;
const PAD = 10;

interface Props {
  building: Building;
  room: string;
  /** The room, when it's mapped (floor plan) or pinned by a student. */
  mapped?: IndoorRoom;
  indoorRooms?: IndoorRoom[];
  /** The door the route uses, if known. */
  door?: Entrance;
  /** Open the inside view (only when there's a mapped way to the room). */
  onOpenInside?: () => void;
  /** Show the room on the map. */
  onShowRoom?: () => void;
  /** Mark where the room is, when it isn't mapped. */
  onPinRoom?: () => void;
  /** Reports the card's height, so the map's buttons can sit below it. */
  onHeight?: (px: number) => void;
}

/**
 * Where the room is in its building, kept in the corner of the map: the
 * building's walls, the room's floor (when mapped) and the room itself.
 * Nothing is drawn for a room nobody has mapped or pinned.
 */
export function RoomInset({ building, room, mapped, indoorRooms, door, onOpenInside, onShowRoom, onPinRoom, onHeight }: Props) {
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

  const level = mapped ? levelsOf(mapped.level)[0] : undefined;
  const floor = level !== undefined ? levelLabel(level) : floorFromRoom(room)?.label;
  const guessed = level === undefined && !!floor;
  const outline = building.outline ?? [];
  const canDraw = !!mapped && (outline.length > 0 || !!mapped.outline);
  const code = building.aliases.find((a) => /^[A-Z0-9-]{2,6}$/.test(a));

  let drawing = null;
  if (canDraw) {
    const proj = fitProjection([...outline.flat(), ...(mapped.outline ?? [mapped.center])], W, PAD, 150);
    const plan = level !== undefined ? floorPlan(indoorRooms, level) : [];
    const isRoom = (r: IndoorRoom) => r === mapped || (!!r.ref && r.ref.toUpperCase() === room.toUpperCase() && levelsOf(r.level)[0] === level);
    const [cx, cy] = proj.xy(mapped.center);
    drawing = (
      <svg viewBox={`0 0 ${W} ${proj.height}`} className="inset-svg" aria-hidden="true">
        {outline.map((r, i) => (
          <path key={i} d={proj.ring(r)} className="inset-walls" />
        ))}
        {plan.map((r, i) => (
          <path key={`p${i}`} d={proj.ring(r.outline!)} className={`inset-space ${r.kind} ${isRoom(r) ? "target" : ""}`} />
        ))}
        {mapped.outline && !plan.includes(mapped) && <path d={proj.ring(mapped.outline)} className="inset-space target" />}
        {door && <circle cx={proj.xy(door.lngLat)[0]} cy={proj.xy(door.lngLat)[1]} r="4" className="inset-door" />}
        {/* A ring around the room so it stands out at this size. */}
        <circle cx={cx} cy={cy} r="9" className="inset-ring" />
        {!mapped.outline && <circle cx={cx} cy={cy} r="4.5" className="inset-pin" />}
      </svg>
    );
  }

  return (
    <div ref={ref} className="room-inset" role="region" aria-label={`Where ${room} is in ${building.name}`}>
      <div className="inset-head">
        <strong>
          {code ? `${code} ` : ""}
          {room}
        </strong>
        <span className="inset-building muted" title={building.name}>
          {building.name}
        </span>
        {floor && (
          <span className="inset-floor">
            {floor}
            {guessed ? " (from the number)" : ""}
          </span>
        )}
      </div>
      {drawing ? (
        <button
          className="inset-draw"
          onClick={onOpenInside ?? onShowRoom}
          aria-label={onOpenInside ? `Show the way to ${room} inside` : `Show ${room} on the map`}
          title={onOpenInside ? "Show the way inside" : "Show on the map"}
        >
          {drawing}
        </button>
      ) : (
        <p className="inset-note">
          Where {room} is inside isn't mapped yet.
          {onPinRoom && (
            <>
              {" "}
              <button className="link" onClick={onPinRoom}>
                Pin it
              </button>
            </>
          )}
        </p>
      )}
      {drawing && (mapped?.source === "pinned" || onOpenInside) && (
        <div className="inset-foot muted">
          <span>{mapped?.source === "pinned" ? "Pinned by a student" : ""}</span>
          {onOpenInside && <span className="inset-cta">Way inside ›</span>}
        </div>
      )}
    </div>
  );
}
