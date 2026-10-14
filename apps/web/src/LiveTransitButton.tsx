import { BusIcon, TrolleyIcon } from "./Icons.tsx";

/** A live-transit button on the map: shows (or hides) every MTS trolley, or every bus near campus, live. */
export function LiveTransitButton({
  mode,
  on,
  loading,
  onToggle,
}: {
  mode: "trolley" | "bus";
  on: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  const name = mode === "trolley" ? "trolleys" : "buses";
  return (
    <button
      className={`map-chip live-chip ${on ? "on" : ""} ${loading ? "loading" : ""}`}
      aria-pressed={on}
      aria-label={on ? `Hide live ${name}` : `Show live ${name}`}
      title={on ? `Hide live ${name}` : `Live ${name}: where they are, which way, and when they reach their next stop`}
      onClick={onToggle}
    >
      {mode === "trolley" ? <TrolleyIcon /> : <BusIcon />} {mode === "trolley" ? "Trolleys" : "Buses"}
    </button>
  );
}
