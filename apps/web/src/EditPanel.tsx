import { useState } from "react";

export type EditTool = "path" | "steps" | "building";

interface Props {
  tool: EditTool;
  onTool: (t: EditTool) => void;
  draftLength: number;
  customPaths: GeoJSON.FeatureCollection;
  selectedId: string | null;
  busy: boolean;
  status: string | null;
  onUndo: () => void;
  onCancelDraft: () => void;
  onFinishLine: () => void;
  onAddBuilding: (name: string, aliases: string[]) => void;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
}

const TOOL_HELP: Record<EditTool, string> = {
  path: "Click along a path on the satellite image. Start and end on an existing path node (white dots when zoomed in) so it connects.",
  steps: "Same as a path, but routed as stairs (skipped by “Avoid stairs”).",
  building: "Click where a building is that OSM is missing, then name it. Codes like PCYNH go in aliases.",
};

/** Dev-only tracing tools. Saves to data/custom-paths.geojson and rebuilds the graph. */
export function EditPanel(p: Props) {
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const lines = p.customPaths.features;

  return (
    <section className="panel edit">
      <h2>Map editor</h2>
      <div className="segmented" role="radiogroup" aria-label="Tool">
        {(["path", "steps", "building"] as const).map((t) => (
          <button key={t} role="radio" aria-checked={p.tool === t} className={p.tool === t ? "on" : ""} onClick={() => p.onTool(t)}>
            {t === "path" ? "Path" : t === "steps" ? "Stairs" : "Building"}
          </button>
        ))}
      </div>
      <p className="muted small">{TOOL_HELP[p.tool]}</p>

      {p.tool === "building" ? (
        p.draftLength > 0 && (
          <form
            className="add-class"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              p.onAddBuilding(
                name.trim(),
                aliases.split(",").map((a) => a.trim()).filter(Boolean),
              );
              setName("");
              setAliases("");
            }}
          >
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pepper Canyon Hall" autoFocus />
            </label>
            <label>
              Aliases (comma separated)
              <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="PCYNH" />
            </label>
            <div className="form-row">
              <button type="submit" className="primary" disabled={p.busy || !name.trim()}>
                Save building
              </button>
              <button type="button" onClick={p.onCancelDraft}>
                Cancel
              </button>
            </div>
          </form>
        )
      ) : (
        <div className="form-row">
          <button className="primary" disabled={p.busy || p.draftLength < 2} onClick={p.onFinishLine}>
            Save line ({p.draftLength} pts)
          </button>
          <button disabled={p.draftLength === 0} onClick={p.onUndo}>
            Undo
          </button>
          <button disabled={p.draftLength === 0} onClick={p.onCancelDraft}>
            Clear
          </button>
        </div>
      )}

      {p.status && <pre className="status">{p.status}</pre>}

      <h3>Your edits ({lines.length})</h3>
      <ul className="class-list">
        {lines.map((f, i) => {
          const id = f.properties?.id as string;
          const label =
            f.geometry.type === "Point"
              ? `Building: ${f.properties?.name}`
              : `${f.properties?.kind === "steps" ? "Stairs" : "Path"} #${i + 1} · ${(f.geometry as GeoJSON.LineString).coordinates.length} pts`;
          return (
            <li key={id} className={p.selectedId === id ? "selected" : ""}>
              <button className="link" onClick={() => p.onSelect(p.selectedId === id ? null : id)}>
                {label}
              </button>
              <button className="icon-btn" aria-label="Delete" disabled={p.busy} onClick={() => p.onDelete(id)}>
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        Wrong OSM path (fenced off, doesn’t exist)? Add its way id to <code>data/blocked-ways.json</code>.
        Public, real-world paths are better added to OpenStreetMap itself so everyone benefits.
      </p>
    </section>
  );
}
