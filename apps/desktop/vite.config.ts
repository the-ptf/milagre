import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rendererCsp } from "./renderer-csp.mjs";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Dev keeps Vite's inline client and HMR socket, so the renderer's policy (renderer-csp.mjs) applies to builds only.
const CSP = rendererCsp();
const contentSecurityPolicy = {
  name: "milagre-csp",
  apply: "build" as const,
  transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" as const }],
};

export default defineConfig({
  root: resolve(projectRoot, "app"),
  // Packaged builds load dist/index.html over file://, so asset URLs must be relative.
  base: "./",
  plugins: [react(), contentSecurityPolicy],
  // Canvas is lazy-loaded. Prebundle it before first paint so its React runtime
  // stays shared with the renderer when the user first opens it in development.
  optimizeDeps: { include: ["@xyflow/react"] },
  resolve: {
    alias: {
      "@": resolve(projectRoot, "app/src"),
    },
  },
  build: {
    outDir: resolve(projectRoot, "dist"),
    emptyOutDir: true,
    // Chunks load from disk in Electron, so size matters less than on the web. The largest are the app itself and Shiki's C++ grammar.
    chunkSizeWarningLimit: 1000,
  },
});
