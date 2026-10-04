import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { customPathsApi } from "./dev-api.ts";

export default defineConfig({
  plugins: [react(), customPathsApi()],
  server: { port: 5173 },
});
