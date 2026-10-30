// Main branch sync settings in Electron: the global switch and the Project's choice save, and the status line follows main-sync:status.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MainSyncDefaultSetting, MainSyncSetting } from '/src/components/Settings';
import '/src/styles.css';
const state = { defaultValue: false, override: null, last: { at: Date.now() - 3 * 60000, outcome: 'skipped', branch: 'main', message: 'The main checkout has uncommitted changes' } };
const listeners = [];
const view = () => ({ branch: 'main', override: state.override, defaultValue: state.defaultValue, enabled: state.override ?? state.defaultValue, last: state.last });
window.milagre = {
  readMainSyncDefault: async () => ({ syncMain: state.defaultValue }),
  saveMainSyncDefault: async (value) => { state.defaultValue = value; return { syncMain: value }; },
  readMainSync: async () => view(),
  saveMainSync: async (_path, override) => { state.override = override; return view(); },
  onMainSyncStatus: (callback) => { listeners.push(callback); return () => {}; },
};
window.__mainSync = { state, emit: (last) => listeners.forEach((callback) => callback({ projectPath: '/work/shop', last })) };
createRoot(document.getElementById('root')).render(
  <div style={{ padding: 12, width: 720 }}><MainSyncDefaultSetting /><MainSyncSetting projectPath="/work/shop" /></div>,
);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-main-sync-settings-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    const toggle = `document.querySelector('[role="checkbox"][aria-label="Sync source branch before new Worktrees"]')`;
    const row = `document.querySelector('[data-main-sync]')`;
    await waitFor(`!!${toggle} && ${row}?.textContent.includes('Skipped 3 min ago: The main checkout has uncommitted changes')`);
    assert.equal(await evaluate(`${toggle}.getAttribute('aria-checked')`), "false", "Off by default");
    await screenshot("default-off");
    await evaluate(`${toggle}.click()`);
    await waitFor(`window.__mainSync.state.defaultValue === true && ${toggle}.getAttribute('aria-checked') === 'true'`);
    await evaluate(`document.querySelector('[data-main-sync] button[aria-label="Sync source branch before new Worktrees"]').click()`);
    await waitFor(`[...document.querySelectorAll('[role="option"]')].some(o => o.textContent.trim() === 'Off')`);
    await evaluate(`[...document.querySelectorAll('[role="option"]')].find(o => o.textContent.trim() === 'Off').click()`);
    await waitFor(`window.__mainSync.state.override === false`);
    await evaluate(`window.__mainSync.emit({ at: Date.now(), outcome: 'updated', branch: 'main', commit: 'a1b2c3d' })`);
    await waitFor(`${row}.textContent.includes('Synced main just now (a1b2c3d)')`);
    await screenshot("project-synced");
    assert.deepEqual(errors, []);
    console.log("PASS: the global main sync switch and the Project's choice save, and the status line follows main-sync:status");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-main-sync-settings"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "main-sync-settings-fixture",
        resolveId(id) {
          if (id === "/__main-sync-settings.tsx") return id;
        },
        load(id) {
          if (id === "/__main-sync-settings.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__main-sync-settings") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__main-sync-settings.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__main-sync-settings`], {
      env,
      stdio: "inherit",
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
