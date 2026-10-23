/**
 * Knobs. Change these instead of hunting through the app.
 * The MTS key still comes from apps/web/.env.local (VITE_MTS_KEY).
 */
export const settings = {
  /** How often to ask MTS where vehicles are. Their GPS updates about every 30–40s. */
  livePollMs: 10_000,
  /** Leave empty to call MTS from the browser. Set this to your own server later, e.g. "/api/vehicles". */
  livePositionsUrl: "",
  /**
   * The arrival model's server (scripts/prediction/live.ts), which says where each bus is going between fixes.
   * From VITE_MODEL_URL in apps/web/.env.local, e.g. http://<server>:8787. Empty: buses glide at their recent speed.
   */
  modelUrl: (import.meta.env.VITE_MODEL_URL as string | undefined) ?? "",
  /** How often to ask the model for the paths of the buses in view. */
  modelPollMs: 10_000,
  /** How often to redraw moving buses. */
  frameMs: 100,
  /** Campus map starts here (zoom and limits as in the full app, apps/web). */
  center: [-117.2376, 32.8801] as [number, number],
  zoom: 15.6,
  /** Campus and the coast on a laptop screen; no further out. */
  minZoom: 13.5,
  /** Room around the campus data's bounding box the map can pan to: enough to see the shore. */
  boundsPaddingDeg: 0.006,
};
