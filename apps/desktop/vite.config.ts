import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { SIMULATOR_RECEIVER_SCRIPT } from "@milagre/shared/simulator-receiver";
import { BROWSER_RECEIVER_SCRIPT } from "@milagre/shared/browser-receiver";
import { DESIGN_CONTROLLER_SCRIPT } from "@milagre/shared/design";
import { ARTIFACT_ESCAPE_SCRIPT } from "@milagre/shared/artifact";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// The packaged renderer shows agent output, so no script may run unless it ships with the app. Images also come from
// the media protocol and GitHub avatars. Dev keeps Vite's inline client and HMR socket, so this applies to builds only.
const CSP = [
  "default-src 'self'",
  // Opaque srcdoc iframes inherit this policy. Only exact bundled scripts run; their data stays inert.
  `script-src 'self' ${[SIMULATOR_RECEIVER_SCRIPT, BROWSER_RECEIVER_SCRIPT, DESIGN_CONTROLLER_SCRIPT, ARTIFACT_ESCAPE_SCRIPT].map((script) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`).join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: milagre-media: https:",
  "media-src 'self' blob: milagre-media:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'self' milagre-artifact:",
].join("; ");
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
