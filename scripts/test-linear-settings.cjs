// Settings > Connections > Linear in Electron: the switch reveals the connections, one row per workspace; Connect adds
// the first, Add another, and each workspace disconnects on its own. Moving issues to In Progress is on by default, and a
// workspace signed in before write access says it can't move them yet.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsNav, SettingsPanel } from '/src/components/Settings';
import '/src/styles.css';
let enabled = false;
window.__moveToStarted = true;
let status = { connected: false, workspaces: [] };
const listeners = new Set();
const acme = { id: 'acme', viewer: { name: 'Victor', email: 'v@x' }, organization: { name: 'Acme', urlKey: 'acme' }, canWrite: true };
const beta = { id: 'beta', viewer: { name: 'Vic', email: 'v@beta' }, organization: { name: 'Beta Labs', urlKey: 'beta' }, canWrite: false };
const statusOf = (workspaces) =>
  workspaces.length ? { connected: true, viewer: workspaces[0].viewer, organization: workspaces[0].organization, workspaces } : { connected: false, workspaces: [] };
// A Mac that predates workspaces sends its one connection without a list.
const connected = { connected: true, viewer: acme.viewer, organization: acme.organization };
window.milagre = {
  listEditors: async () => [], listRecentProjects: async () => [], listProjects: async () => [],
  readLinearEnabled: async () => ({ enabled, moveToStarted: window.__moveToStarted }),
  saveLinearMoveToStarted: async (value) => ({ moveToStarted: (window.__moveToStarted = value) }),
  saveLinearEnabled: async (value) => ({ enabled: (enabled = value) }),
  readLinearStatus: async () => status,
  connectLinear: (options) =>
    (window.__connects.push(options?.window === true ? 'window' : 'browser'), window.__hangConnect)
      ? new Promise((resolve, reject) => {
          window.__rejectConnect = () => reject(new Error('Linear sign-in timed out. Try again.'));
          window.__rejectReplaced = () => reject(new Error('Error invoking remote method: Replaced by a newer Linear sign-in.'));
        })
      : new Promise((resolve) => setTimeout(() => {
          const list = status.workspaces ?? [];
          resolve((status = statusOf([...list, list.some((item) => item.id === 'acme') ? beta : acme])));
        }, 300)),
  disconnectLinear: async (id) => (status = statusOf((status.workspaces ?? [acme]).filter((item) => item.id !== id))),
  onLinearStatusChanged: (callback) => (listeners.add(callback), () => listeners.delete(callback)),
};
// What the Mac's daemon does when the status changes behind the window's back (a phone, or a sign-in finishing).
window.__emitLinear = (next) => {
  status = next;
  listeners.forEach((callback) => callback(next));
};
window.__connectedStatus = connected;
window.__connects = [];
function Fixture() {
  const [section, setSection] = useState('appearance');
  return (
    <div style={{ display: 'flex', gap: 12, height: '100vh', padding: 12 }}>
      <SettingsNav section={section} onSelect={setSection} onSelectProject={() => {}} onBack={() => {}} showProjectSettings={false} />
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section={section} models={[]} update={null} /></main>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-linear-settings-")));
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
  const toggle = `document.querySelector('[role="checkbox"][aria-label="Linear"]')`;
  const button = (label) => `[...document.querySelectorAll('[data-linear-settings] button')].find(b => b.textContent.trim() === '${label}')`;
  const text = `document.querySelector('[data-linear-settings]').textContent`;
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Connections')`);
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Connections').click()`);
    await waitFor(`!!${toggle}`);
    assert.equal(await evaluate(`!!${button("Connect")}`), false, "Connection hidden while the switch is off");
    await screenshot("off");
    await evaluate(`${toggle}.click()`);
    await waitFor(`!!${button("Connect")}`);
    assert.match(await evaluate(text), /Not connected/);
    await screenshot("not-connected");
    await evaluate(`${button("Connect")}.click()`);
    await waitFor(`${text}.includes('Finish signing in to Linear in your browser.')`);
    assert.equal(await evaluate(`!!${button("Start again")}`), true);
    await screenshot("connecting");
    await waitFor(`document.querySelector('[data-linear-settings]').dataset.linearConnected === 'true'`);
    assert.match(await evaluate(text), /AcmeSigned in as Victor/);
    assert.equal(await evaluate(`!!${button("Add")}`), true, "a connected Mac can add another workspace");
    await screenshot("connected");
    assert.deepEqual(await evaluate(`window.__connects`), ["browser"], "the first Connect keeps the browser's Linear login");
    // Add signs in afresh in a window of its own, and offers the browser instead while it waits.
    await evaluate(`window.__hangConnect = true`);
    await evaluate(`${button("Add")}.click()`);
    await waitFor(`${text}.includes('Finish signing in in the Linear window')`);
    assert.equal(await evaluate(`window.__connects.at(-1)`), "window");
    await evaluate(`document.querySelector('[data-linear-connect]').scrollIntoView({ block: 'center' })`);
    await screenshot("adding-in-window");
    await evaluate(`document.querySelector('[data-linear-use-browser]').click()`);
    await waitFor(`window.__connects.length === 3`);
    assert.equal(await evaluate(`window.__connects.at(-1)`), "browser");
    assert.match(await evaluate(text), /Finish signing in to Linear in your browser\./);
    assert.equal(await evaluate(`!!document.querySelector('[data-linear-use-browser]')`), false);
    // Closing the window (or a newer sign-in) ends the waiting one quietly: the row goes back to Add, with no error.
    await evaluate(`window.__rejectConnect = null; window.__hangConnect = false`);
    await evaluate(`${button("Start again")}.click()`);
    await waitFor(`document.querySelectorAll('[data-linear-workspace]').length === 2`);
    await evaluate(`document.querySelector('[data-linear-workspace="beta"]').click()`);
    await waitFor(`document.querySelectorAll('[data-linear-workspace]').length === 1`);
    await evaluate(`window.__hangConnect = true`);
    await evaluate(`${button("Add")}.click()`);
    await waitFor(`typeof window.__rejectConnect === 'function'`);
    await evaluate(`window.__rejectReplaced()`);
    await waitFor(`!!${button("Add")}`);
    assert.equal(await evaluate(`!!document.querySelector('[data-linear-settings] .text-red')`), false, "a closed window shows no error");
    await evaluate(`window.__hangConnect = false`);
    // Add signs in to a second workspace; both get a row of their own.
    await evaluate(`${button("Add")}.click()`);
    await waitFor(`document.querySelectorAll('[data-linear-workspace]').length === 2`);
    assert.match(await evaluate(text), /Beta LabsSigned in as Vic/);
    await evaluate(`document.querySelector('[data-linear-connect]').scrollIntoView({ block: 'center' })`);
    await screenshot("two-workspaces");
    // Moving issues is on by default; only the read-only sign-in says it can't, and only while the switch is on.
    const moveSwitch = `document.querySelector('[role="checkbox"][aria-label="Move issues to In Progress"]')`;
    assert.equal(await evaluate(`${moveSwitch}.getAttribute('aria-checked')`), "true");
    const readOnly = /Beta LabsSigned in as Vic\. Can't move issues yet\. Sign in to this workspace again with Add workspace to allow it\./;
    assert.match(await evaluate(text), readOnly);
    assert.doesNotMatch(await evaluate(text), /Signed in as Victor\. Can't/);
    await evaluate(`${moveSwitch}.scrollIntoView({ block: 'center' })`);
    await screenshot("move-to-in-progress");
    await evaluate(`${moveSwitch}.click()`);
    await waitFor(`window.__moveToStarted === false`);
    await waitFor(`${moveSwitch}.getAttribute('aria-checked') === 'false'`);
    assert.doesNotMatch(await evaluate(text), /Can't move issues yet/);
    await evaluate(`${moveSwitch}.click()`);
    await waitFor(`window.__moveToStarted === true`);
    // Disconnect ends only its own workspace.
    await evaluate(`document.querySelector('[data-linear-workspace="acme"]').click()`);
    await waitFor(`document.querySelectorAll('[data-linear-workspace]').length === 1`);
    assert.equal(await evaluate(`!!document.querySelector('[data-linear-workspace="beta"]')`), true);
    assert.doesNotMatch(await evaluate(text), /Acme/);
    await evaluate(`${button("Disconnect")}.click()`);
    // A status that arrives from the daemon (a sign-in that finished elsewhere) updates the row without a click.
    await evaluate(`window.__emitLinear(window.__connectedStatus)`);
    await waitFor(`document.querySelector('[data-linear-settings]').dataset.linearConnected === 'true'`);
    assert.match(await evaluate(text), /AcmeSigned in as Victor/);
    await evaluate(`${button("Disconnect")}.click()`);
    await waitFor(`document.querySelector('[data-linear-settings]').dataset.linearConnected === 'false'`);
    // A connect still waiting when the connected status arrives ends quietly: no error, no "Start again", even when
    // the waiting call later fails.
    await evaluate(`window.__hangConnect = true`);
    await evaluate(`${button("Connect")}.click()`);
    await waitFor(`!!${button("Start again")}`);
    await evaluate(`window.__emitLinear(window.__connectedStatus)`);
    await waitFor(`document.querySelector('[data-linear-settings]').dataset.linearConnected === 'true'`);
    await evaluate(`window.__rejectConnect()`);
    await delay(150);
    const row = await evaluate(text);
    assert.match(row, /AcmeSigned in as Victor/);
    assert.doesNotMatch(row, /timed out|Finish signing in/);
    assert.equal(await evaluate(`!!${button("Start again")}`), false);
    assert.equal(await evaluate(`!!document.querySelector('[data-linear-settings] .text-red')`), false, "no error shown");
    await screenshot("connected-elsewhere");
    assert.deepEqual(errors, []);
    console.log("PASS: Settings > Connections > Linear shows the connections only when on, adds workspaces through the browser and disconnects each");
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
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-linear-settings"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "linear-settings-fixture",
        resolveId(id) {
          if (id === "/__linear-settings.tsx") return id;
        },
        load(id) {
          if (id === "/__linear-settings.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__linear-settings") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__linear-settings.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__linear-settings`], {
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
