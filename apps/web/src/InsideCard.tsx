import { floorPhrase, type InsideHints } from "@campus/core";
import type { ReactNode } from "react";

/** What to do on arrival: which door, which floor, elevator, and student tips. */
export function InsideCard({
  buildingName,
  hints,
  stepFree,
  tips,
  onShowRoom,
  onPinRoom,
}: {
  buildingName: string;
  hints: InsideHints;
  stepFree: boolean;
  tips: string[];
  /** Zoom the map to the room's spot. */
  onShowRoom?: () => void;
  /** Start marking where an unmapped room is. */
  onPinRoom?: () => void;
}) {
  const rows: [string, ReactNode][] = [];
  if (hints.enterBy) rows.push(["Enter", <>Use {hints.enterBy}.</>]);
  if (hints.room) {
    const floor = hints.floor;
    rows.push([
      "Room",
      <>
        {floor ? (
          <>
            {hints.room}: it's <strong>{floorPhrase(floor)}</strong>
            {floor.source === "number" && <span className="muted"> (going by the room number)</span>}
            {floor.source === "pinned" && <span className="muted"> (pinned by a student)</span>}.
          </>
        ) : (
          <>Look for {hints.room} once inside.</>
        )}{" "}
        {onShowRoom ? (
          <button className="link" onClick={onShowRoom}>
            Show it on the map
          </button>
        ) : (
          onPinRoom && (
            <button className="link" onClick={onPinRoom}>
              Pin this room
            </button>
          )
        )}
      </>,
    ]);
  }
  if (stepFree || (hints.floor && hints.floor.floor !== "1" && hints.floor.floor !== "0")) {
    rows.push([
      "Elevator",
      hints.elevator === "mapped" ? (
        <>This building has an elevator on the map.</>
      ) : (
        <>No elevator is mapped here, so check signs inside or ask at the front desk.</>
      ),
    ]);
  }
  tips.forEach((t) => rows.push(["Tip", t]));
  if (!rows.length) return null;
  return (
    <section className="inside" aria-label={`Inside ${buildingName}`}>
      <h3>Inside {buildingName}</h3>
      <dl>
        {rows.map(([k, v], i) => (
          <div key={i}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
