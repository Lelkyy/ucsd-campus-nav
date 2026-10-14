/** The Spin button on the map: shows (or hides) the nearest Spin e-bikes free to ride. */
export function SpinButton({ on, loading, onToggle }: { on: boolean; loading: boolean; onToggle: () => void }) {
  return (
    <button
      className={`spin-chip ${on ? "on" : ""}`}
      aria-pressed={on}
      aria-label={on ? "Hide Spin e-bikes" : "Show the nearest Spin e-bikes"}
      title={on ? "Hide Spin e-bikes" : "Nearest Spin e-bikes"}
      onClick={onToggle}
    >
      <span className={`spin-mark ${loading ? "loading" : ""}`} aria-hidden="true">
        spin
      </span>
    </button>
  );
}
