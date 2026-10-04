import type { InsideHints } from "@campus/core";
import type { ReactNode } from "react";

/** What to do on arrival: which door, which floor, elevator, and student tips. */
export function InsideCard({
  buildingName,
  hints,
  stepFree,
  tips,
}: {
  buildingName: string;
  hints: InsideHints;
  stepFree: boolean;
  tips: string[];
}) {
  const rows: [string, ReactNode][] = [];
  if (hints.enterBy) rows.push(["Enter", <>Use {hints.enterBy}.</>]);
  if (hints.room && hints.floor) {
    rows.push([
      "Room",
      <>
        {hints.room} is on <strong>{hints.floor.label.toLowerCase()}</strong>
        {hints.floor.source === "number" && <span className="muted"> (going by the room number)</span>}
        {hints.floor.source === "map" && <span className="muted"> (marked on the map)</span>}.
      </>,
    ]);
  } else if (hints.room) {
    rows.push(["Room", <>Look for {hints.room} once inside; its floor isn't mapped.</>]);
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
