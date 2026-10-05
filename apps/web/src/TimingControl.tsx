export type TimingState = { kind: "now" } | { kind: "depart"; at: Date } | { kind: "arrive"; at: Date; label?: string };

/** Leave now / Depart at / Arrive by, like Google Maps. */
export function TimingControl({ value, onChange }: { value: TimingState; onChange: (t: TimingState) => void }) {
  const at = value.kind === "now" ? roundUp(new Date()) : value.at;
  return (
    <div className="timing">
      <select
        aria-label="When"
        value={value.kind}
        onChange={(e) => {
          const kind = e.target.value as TimingState["kind"];
          onChange(kind === "now" ? { kind } : { kind, at });
        }}
      >
        <option value="now">Leave now</option>
        <option value="depart">Depart at</option>
        <option value="arrive">Arrive by</option>
      </select>
      {value.kind !== "now" && (
        <input
          type="datetime-local"
          aria-label={value.kind === "arrive" ? "Arrive by" : "Depart at"}
          value={toLocalInput(value.at)}
          onChange={(e) => {
            const d = new Date(e.target.value);
            if (!Number.isNaN(d.getTime())) onChange({ ...value, at: d, ...(value.kind === "arrive" ? { label: undefined } : {}) });
          }}
        />
      )}
    </div>
  );
}

function roundUp(d: Date): Date {
  const r = new Date(d);
  r.setSeconds(0, 0);
  r.setMinutes(Math.ceil(r.getMinutes() / 5) * 5);
  return r;
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
