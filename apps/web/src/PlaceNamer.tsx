import type { LngLat } from "@campus/core";
import { useState } from "react";
import { suggestPlaceHref } from "./useSavedPlaces.ts";

/** "Name this place": save a spot under your own name, and optionally suggest it for everyone. */
export function PlaceNamer({ at, defaultName, onSave }: { at: LngLat; defaultName?: string; onSave: (name: string, note?: string) => void }) {
  const [open, setOpen] = useState(false);
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
  if (!open) {
    return (
      <button className="link" onClick={() => setOpen(true)}>
        Name this place…
      </button>
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
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
