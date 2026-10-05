import type { InsideHints } from "@campus/core";
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
  /** Zoom the map to the room on its floor plan. */
  onShowRoom?: () => void;
  /** Start marking where an unmapped room is. */
  onPinRoom?: () => void;
}) {
  const rows: [string, ReactNode][] = [];
  if (hints.enterBy) rows.push(["Enter", <>Use {hints.enterBy}.</>]);
  if (hints.room && hints.mappedRoom) {
    rows.push([
      "Room",
      <>
        {hints.room} is on <strong>{hints.floor?.label.toLowerCase() ?? "an unknown floor"}</strong>
        <span className="muted">{hints.floor?.source === "pinned" ? " (pinned by a student)" : " (from the floor plan)"}</span>.{" "}
        {onShowRoom && (
          <button className="link" onClick={onShowRoom}>
            Show it on the map
          </button>
        )}
      </>,
    ]);
  } else if (hints.room) {
    rows.push([
      "Room",
      <>
        {hints.floor ? (
          <>
            {hints.room} is probably on <strong>{hints.floor.label.toLowerCase()}</strong>
            <span className="muted"> (going by the room number)</span>.
          </>
        ) : (
          <>Look for {hints.room} once inside.</>
        )}{" "}
        <span className="muted">Its exact spot isn't mapped yet.</span>{" "}
        {onPinRoom && (
          <button className="link" onClick={onPinRoom}>
            Pin this room
          </button>
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
