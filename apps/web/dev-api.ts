/**
 * Dev-server-only API backing the map editor:
 *   GET /__dev/custom-paths  -> data/custom-paths.geojson
 *   PUT /__dev/custom-paths  -> overwrite it, rebuild the graph, return the build log
 * Never included in production builds (apply: "serve").
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CUSTOM_PATH = join(ROOT, "data/custom-paths.geojson");

export function customPathsApi(): Plugin {
  return {
    name: "custom-paths-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/custom-paths", async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        try {
          if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            res.end(await readFile(CUSTOM_PATH, "utf8"));
            return;
          }
          if (req.method !== "PUT") return send(405, { error: "GET or PUT only" });

          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const fc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
            return send(400, { error: "expected a GeoJSON FeatureCollection" });
          }
          await writeFile(CUSTOM_PATH, JSON.stringify(fc, null, 2) + "\n");
          const log = await rebuildGraph();
          send(200, { ok: true, log });
        } catch (err) {
          send(500, { error: (err as Error).message });
        }
      });
    },
  };
}

function rebuildGraph(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("npx", ["tsx", "scripts/build-graph.ts"], { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}
