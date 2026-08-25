import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(rootDirectory, "dashboard"),
  plugins: [react()],
  resolve: {
    alias: {
      "@trace": path.join(rootDirectory, "src/trace/contracts.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.DASHBOARD_API_TARGET ?? "http://127.0.0.1:4310",
      },
    },
  },
  build: {
    outDir: path.join(rootDirectory, "dashboard/dist"),
    emptyOutDir: true,
  },
});
