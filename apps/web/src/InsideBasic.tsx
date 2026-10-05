import { bearing, compass, distanceMeters, floorToLevel, type Building, type InsideHints, type LngLat } from "@campus/core";
import { CloseIcon } from "./Icons.tsx";
import { fitProjection } from "./planProjection.ts";

const W = 640;
const PAD = 36;

interface Props {
  building: Building;
  room?: string;
  hints: InsideHints;
  /** Where the route reaches the building (used when its doors aren't mapped). */
  arrival?: LngLat;
  stepFree?: boolean;
  onClose: () => void;
  onPinRoom?: () => void;
}

/**
 * The inside view for a building whose rooms and hallways aren't mapped: only
 * what is known is drawn (walls, doors and the one your route uses, elevators,
 * a room a student pinned), with written directions for the rest. No hallways
 * or routes are made up.
 */
export function InsideBasic({ building, room, hints, arrival, stepFree, onClose, onPinRoom }: Props) {
  const outline = building.outline ?? [];
  const door = hints.entrance;
  const pinned = hints.mappedRoom?.source === "pinned" ? hints.mappedRoom : undefined;
  const proj = fitProjection(
    [
      ...outline.flat(),
      ...(building.entrances ?? []).map((d) => d.lngLat),
      ...(door ? [] : arrival ? [arrival] : []),
      ...(pinned ? [pinned.center] : []),
    ],
    W,
    PAD,
  );
  const { xy, scale, widthM, height: H, ring } = proj;
  const scaleBarM = niceMeters(widthM / 4);

  // Written directions: the door, the floor, then the room.
  const steps: string[] = [];
  steps.push(door ? `Go in at the green door: ${hints.enterBy}.` : hints.enterBy ? `Go in by ${hints.enterBy}.` : "Go in at the nearest door.");
  const floor = hints.floor;
  if (room && floor) {
    const level = floor.source === "number" ? floorToLevel(floor.floor) : Number(floor.floor.split(";")[0]);
    const how =
      level === 0
        ? ""
        : building.elevators
          ? ` Take ${level > 0 ? "the elevator (E) or the stairs up" : "the elevator (E) or the stairs down"}.`
          : stepFree
            ? " No elevator is mapped here, so ask at the front desk for the step-free way."
            : ` Take the stairs or an elevator ${level > 0 ? "up" : "down"}.`;
    const source = floor.source === "number" ? " (going by the room number)" : floor.source === "pinned" ? " (pinned by a student)" : "";
    steps.push(`${room} is on ${floor.label.toLowerCase().startsWith("floor") ? floor.label : floor.label.toLowerCase()}${source}.${how}`);
  }
  if (room && pinned && door) {
    const m = Math.round(distanceMeters(door.lngLat, pinned.center));
    steps.push(`${room} is about ${m} m ${compass(bearing(door.lngLat, pinned.center))} of the door (straight line).`);
  } else if (room && !pinned) {
    steps.push(`Follow the room numbers to ${room}; its exact spot isn't mapped yet.`);
  }

  return (
    <div className="inside-view" role="dialog" aria-label={`Inside ${building.name}`}>
      <div className="inside-view-card">
        <header className="inside-view-head">
          <div>
            <h2>Inside {building.name}</h2>
            <p className="muted small">
              {room ? `Room ${room}` : "Doors and elevators"}
              {room && floor ? ` · ${floor.label}` : ""}
            </p>
          </div>
          <button className="icon-btn" aria-label="Close inside view" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="inside-view-body single">
          <svg viewBox={`0 0 ${W} ${H}`} className="inside-svg" role="img" aria-label={`${building.name}: walls, doors and elevators`}>
            {outline.map((r, i) => (
              <path key={i} d={ring(r)} className="iv-footprint" />
            ))}
            {(building.elevatorsAt ?? []).map((p, i) => {
              const [x, y] = xy(p);
              return (
                <g key={`e${i}`} transform={`translate(${x},${y})`}>
                  <rect x="-8" y="-8" width="16" height="16" rx="3" className="iv-elevator" />
                  <text y="4" className="iv-elevator-text">
                    E
                  </text>
                </g>
              );
            })}
            {pinned && (
              <g transform={`translate(${xy(pinned.center).join(",")})`}>
                <circle r="12" className="iv-pin" />
                <text y="4" className="iv-pin-text">
                  {room}
                </text>
              </g>
            )}
            {(building.entrances ?? []).map((d, i) => {
              const [x, y] = xy(d.lngLat);
              const used = d === door;
              const cls = used ? "used" : d.wheelchair === "yes" ? "accessible" : d.kind === "main" ? "main" : d.kind === "emergency" || d.kind === "exit" ? "emergency" : "";
              return (
                <g key={`d${i}`} transform={`translate(${x},${y})`}>
                  <circle r={used ? 9 : 6} className={`iv-door ${cls}`} />
                  {used && (
                    <text y="-14" className="iv-door-label">
                      Enter here
                    </text>
                  )}
                </g>
              );
            })}
            {!door && arrival && (
              <g transform={`translate(${xy(arrival).join(",")})`}>
                <circle r="10" className="iv-arrival" />
                <text y="-15" className="iv-door-label">
                  Enter near here
                </text>
              </g>
            )}
            <g transform={`translate(${W - 26}, 26)`} className="iv-north">
              <path d="M0,-12 L6,6 L0,2 L-6,6 Z" />
              <text y="20">N</text>
            </g>
            <g transform={`translate(${PAD}, 16)`} className="iv-scale">
              <line x1="0" y1="0" x2={scaleBarM * scale} y2="0" />
              <text x={scaleBarM * scale + 6} y="4">
                {scaleBarM} m
              </text>
            </g>
          </svg>
        </div>

        <div className="inside-view-foot">
          <ol className="iv-steps all">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <ul className="iv-legend">
            {door && (
              <li>
                <span className="sw used" /> Your door
              </li>
            )}
            {building.entrances?.some((d) => d.kind === "main") && (
              <li>
                <span className="sw main" /> Main entrance
              </li>
            )}
            {building.entrances?.some((d) => d.wheelchair === "yes") && (
              <li>
                <span className="sw accessible" /> Accessible door
              </li>
            )}
            {(building.elevatorsAt?.length ?? 0) > 0 && (
              <li>
                <span className="sw elevator" /> Elevator
              </li>
            )}
          </ul>
          <p className="muted small iv-unmapped">
            Hallways and rooms inside aren't mapped here yet, so only the walls{building.entrances?.length ? ", doors" : ""}
            {building.elevatorsAt?.length ? " and elevators" : ""} are drawn.
            {room && !pinned && onPinRoom && (
              <>
                {" "}
                Found {room}?{" "}
                <button className="link" onClick={onPinRoom}>
                  Pin it
                </button>{" "}
                for the next person.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

function niceMeters(m: number): number {
  for (const n of [5, 10, 20, 25, 50, 100, 200]) if (n >= m) return n;
  return 200;
}
