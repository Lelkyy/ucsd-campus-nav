import { settings } from "../settings.ts";
import type { TimedPath } from "./Motion.ts";

/**
 * Asks the arrival model where the buses in view are going: for each, a path through its next stops at the
 * model's predicted times. Calls you with them by vehicle id. One request at a time, only while the page is visible.
 */
export class ModelFeed {
  private busy = false;

  constructor(
    private readonly bbox: () => [number, number, number, number],
    private readonly onPaths: (paths: Map<string, TimedPath>) => void,
  ) {}

  start(): void {
    if (!settings.modelUrl) return;
    void this.tick();
    window.setInterval(() => void this.tick(), settings.modelPollMs);
  }

  private async tick(): Promise<void> {
    if (this.busy || document.hidden) return;
    this.busy = true;
    try {
      const res = await fetch(`${settings.modelUrl.replace(/\/$/, "")}/vehicles?bbox=${this.bbox().map((x) => x.toFixed(4)).join(",")}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { vehicles: { id: string; path: TimedPath }[] };
      this.onPaths(new Map(json.vehicles.map((v) => [v.id, v.path])));
    } catch {
      // The next tick tries again; meanwhile buses glide at their recent speed.
    } finally {
      this.busy = false;
    }
  }
}
