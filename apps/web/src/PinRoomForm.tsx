import { floorFromRoom, floorToLevel, type LngLat } from "@campus/core";
import { useState } from "react";
import { suggestRoomHref, type RoomPin } from "./useRoomPins.ts";

const FLOORS = ["B", "1", "2", "3", "4", "5", "6", "7", "8"];

/** Mark where a room is: tap its spot on the map, pick the floor, save (and share). */
export function PinRoomForm({
  roomKey,
  at,
  onSave,
  onCancel,
}: {
  roomKey: string;
  at: LngLat | null;
  onSave: (pin: RoomPin) => void;
  onCancel: () => void;
}) {
  const room = roomKey.split(" ").slice(1).join(" ");
  const guess = floorFromRoom(room)?.floor;
  const [floor, setFloor] = useState(guess && FLOORS.includes(guess) ? guess : "1");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<RoomPin | null>(null);

  if (saved) {
    return (
      <div className="pin-room">
        <p className="note">
          Pinned {roomKey}. It's saved on this device.{" "}
          <a className="link" href={suggestRoomHref(roomKey, saved)}>
            Send it to the map team
          </a>{" "}
          so everyone sees it.
        </p>
        <button onClick={onCancel}>Done</button>
      </div>
    );
  }
  return (
    <form
      className="pin-room"
      onSubmit={(e) => {
        e.preventDefault();
        if (!at) return;
        const pin: RoomPin = { at, level: String(floorToLevel(floor)), ...(note.trim() ? { note: note.trim() } : {}) };
        onSave(pin);
        setSaved(pin);
      }}
    >
      <strong>Pin {roomKey}</strong>
      <p className="muted small">
        {at ? "Got it. Drag the map and tap again to adjust." : "Tap the room's spot on the map (zoom in on the building)."}
      </p>
      <div className="form-row">
        <label>
          Floor
          <select value={floor} onChange={(e) => setFloor(e.target.value)}>
            {FLOORS.map((f) => (
              <option key={f} value={f}>
                {f === "B" ? "Basement" : f === "1" ? "1 (ground)" : f}
              </option>
            ))}
          </select>
        </label>
        <label>
          How to find it (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Up the stairs, second door left" />
        </label>
      </div>
      <div className="form-row wrap">
        <button type="submit" className="primary" disabled={!at}>
          Save pin
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
