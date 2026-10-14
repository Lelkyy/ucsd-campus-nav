/** The Spin button on the map: shows (or hides) the nearest Spin e-bikes and scooters free to ride. */
export function SpinButton({ on, loading, onToggle }: { on: boolean; loading: boolean; onToggle: () => void }) {
  return (
    <button
      className={`spin-chip ${on ? "on" : ""}`}
      aria-pressed={on}
      aria-label={on ? "Hide Spin vehicles" : "Show the nearest Spin e-bikes and scooters"}
      title={on ? "Hide Spin vehicles" : "Nearest Spin e-bikes and scooters (not affiliated with Spin)"}
      onClick={onToggle}
    >
      <span className={`spin-mark ${loading ? "loading" : ""}`} aria-hidden="true">
        spin
      </span>
    </button>
  );
}
