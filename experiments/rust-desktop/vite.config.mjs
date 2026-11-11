import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rendererCsp } from "../../apps/desktop/renderer-csp.mjs";

const experiment = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(experiment, "../../apps/desktop");
const preloadId = "\0virtual:milagre-electron-preload";
const csp = rendererCsp().replace("connect-src 'self'", "connect-src 'self' ipc: http://ipc.localhost");

export default defineConfig({
  root: resolve(experiment, "renderer"),
  publicDir: resolve(desktop, "app/public"),
  base: "./",
  plugins: [
    react(),
    {
      name: "milagre-production-preload",
      resolveId(id) {
        if (id === "virtual:milagre-electron-preload") return preloadId;
      },
      load(id) {
        if (id !== preloadId) return;
        // Build the same bridge methods and event subscriptions as Electron from its source.
        // Only the transport and the two launch flags belong to this shell.
        return readFileSync(resolve(desktop, "electron/preload.cjs"), "utf8")
          .replace(
            'const { contextBridge, ipcRenderer: electronIpc, webUtils } = require("electron");',
            'import { contextBridge, ipcRenderer as electronIpc, webUtils } from "' + resolve(experiment, "renderer/electron-shim.js") + '";',
          )
          .replaceAll("process.argv", '["--milagre-window-controls=leading", "--milagre-opened-projects-before=1"]');
      },
    },
    {
      name: "milagre-renderer-csp",
      transformIndexHtml(html) {
        // Keep charset in the first 1024 bytes; the production CSP hashes are long.
        const escaped = csp.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
        return html.replace(/(<meta charset="UTF-8"\s*\/?>)/i, '$1\n    <meta http-equiv="Content-Security-Policy" content="' + escaped + '">');
      },
    },
  ],
  resolve: {
    alias: { "@": resolve(desktop, "app/src") },
    dedupe: ["react", "react-dom"],
  },
  css: { postcss: { plugins: [tailwindcss({ base: resolve(desktop, "app") })] } },
  build: {
    outDir: resolve(experiment, "dist"),
    emptyOutDir: true,
    target: "safari16.4",
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
});
