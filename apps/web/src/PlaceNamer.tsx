import type { LngLat } from "@campus/core";
import { useState } from "react";
import { suggestPlaceHref } from "./useSavedPlaces.ts";

/** Save a spot under your own name, and optionally suggest the name for everyone. */
export function PlaceNamer({
  at,
  defaultName,
  onSave,
  onClose,
}: {
  at: LngLat;
  defaultName?: string;
  onSave: (name: string, note?: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName ?? "");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  if (saved) {
    return (
      <p className="note">
        Saved “{saved}”. Do other students call it that?{" "}
        <a className="link" href={suggestPlaceHref(saved, at, note || undefined)}>
          Suggest it for everyone
        </a>
      </p>
    );
  }
  return (
    <form
      className="namer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSave(name.trim(), note.trim() || undefined);
        setSaved(name.trim());
      }}
    >
      <label>
        What do students call it?
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Muir Field drop-off" />
      </label>
      <label>
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pull-in by the tennis courts" />
      </label>
      <div className="form-row wrap">
        <button type="submit" className="primary" disabled={!name.trim()}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
