// Run with npm test -- --only test-computer-settings. A computer's Settings in Electron against a stand-in for main: the
// Computers group lists This Mac and each computer; its section shows how it is connected and which route is in use, what
// lives there, saves its name when the field is left, and Remove asks once more before it goes to Settings › Devices.
// Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { thisComputer } = require("@milagre/shared/host-computer");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsNav, SettingsPanel } from "/src/components/Settings";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const HOUR = 3600000;
let computers = [
  { id: "c-arketa", name: "arketa", hostId: "a".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: Date.parse("2026-10-08T10:00:00"), message: null, lan: true, lanRoutes: ["ws://192.168.0.24:8798"] },
  { id: "c-studio", name: "studio", hostId: "s".repeat(22), relayHost: "relay.milagre.cloud", state: "offline", route: null, lastSeen: Date.now() - 2 * HOUR, addedAt: Date.parse("2026-10-01T10:00:00"), message: null, lan: false, lanRoutes: [] },
];
let changed = () => {};
const snapshot = () => ({ thisMac: "victor-mbp", computers });
window.renames = [];
window.removed = [];
window.autoSaves = [];
const fallback = { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } };
// A paired computer's own calls: only Auto update and its memory and disk answer; the rest stay as an older computer that has nothing.
const GB = 1024 ** 3;
const remote = (id) => ({
  readComputerResources: async () => ({
    memory: {
      total: 32 * GB,
      available: 20 * GB,
      milagre: 2 * GB,
      parts: [
        { kind: "claude", bytes: 1.5 * GB, count: 2 },
        { kind: "app", bytes: 0.5 * GB, count: 0 },
      ],
    },
    disk: {
      total: 2e12,
      available: 1.5e12,
      milagre: 80e9,
      parts: [
        { kind: "worktrees", bytes: 75e9, count: 12 },
        { kind: "data", bytes: 5e9, count: 0 },
      ],
      measuredAt: Date.now(),
      measuring: false,
    },
  }),
  readAutoUpdate: async () => ({ autoUpdate: false }),
  saveAutoUpdate: async (value) => (window.autoSaves.push([id, value]), { autoUpdate: value }),
  onAutoUpdate: () => () => {},
  // Its desktop app has downloaded a newer Milagre; installing restarts it there.
  readHostUpdate: async () => window.hostUpdate,
  checkHostUpdate: async () => window.hostUpdate,
  installHostUpdate: async () => (window.installs.push(id), (window.hostUpdate = { ...window.hostUpdate, status: "installing" })),
});
window.installs = [];
window.hostUpdate = { status: "downloaded", version: "0.122.0", progress: 100, current: "0.121.0" };
window.milagre = new Proxy({
  on: remote,
  listRecentProjects: async () => [],
  listEditors: async () => [],
  onComputersChanged: (callback) => ((changed = callback), () => {}),
  computers: {
    list: async () => snapshot(),
    invoke: async (id, method) => (method === "daemon:status" ? { version: "0.121.0" } : method === "project:recent" ? [{ path: "/a/web", name: "arketa-web" }, { path: "/a/infra", name: "infra" }] : null),
    rename: async (id, name) => {
      window.renames.push([id, name]);
      computers = computers.map((item) => (item.id === id ? { ...item, name } : item));
      changed(snapshot());
      return snapshot();
    },
    remove: async (id) => {
      window.removed.push(id);
      computers = computers.filter((item) => item.id !== id);
      changed(snapshot());
      return snapshot();
    },
  },
}, fallback);
updateSettings({ otherComputers: true });
function Fixture() {
  const [section, setSection] = useState("appearance");
  const [computerId, setComputerId] = useState(undefined);
  return (
    <div style={{ display: "flex", gap: 12, height: "100vh", padding: 12 }}>
      <SettingsNav section={section} computerId={computerId} onSelect={setSection} onSelectComputer={(id) => { setComputerId(id); setSection("computer"); }} onSelectProject={() => {}} onBack={() => {}} showProjectSettings={false} />
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section={section} computerId={computerId} models={[]} update={null} onSectionChange={(next) => { window.sectionAfter = next; }} /></main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-computer-settings-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 960, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
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
    throw new Error(`Timed out: ${source}`);
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
    const nav = (name) => `[...document.querySelectorAll('[data-settings-computers] button')].find((b) => b.textContent.includes(${JSON.stringify(name)}))`;
    const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
    await waitFor(`!!document.querySelector('[data-settings-computers]')`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-settings-computers] button')].map((b) => b.textContent.trim())`), [
      "victor-mbp",
      "arketa",
      "studio",
    ]);
    await evaluate(`${nav("arketa")}.click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'arketa' && !!document.querySelector('[data-computer-settings]')`);
    await waitFor(`document.querySelector('[data-computer-status]')?.textContent.includes('Milagre 0.121.0')`);
    assert.match(await text("[data-computer-status]"), /^Connected · Milagre 0\.121\.0 · paired Oct 8$/);
    assert.equal(await text('[data-connection="lan"] [data-connection-state]'), "In use");
    assert.match(await text('[data-connection="lan"]'), /ws:\/\/192\.168\.0\.24:8798, end-to-end encrypted/);
    assert.equal(await text('[data-connection="relay"] [data-connection-state]'), "Ready");
    await waitFor(`document.querySelector('[data-computer-projects]')?.textContent.includes('2 Projects')`);
    assert.match(await text("[data-computer-projects]"), /arketa-web, infra\. Accounts and simulators stay on arketa\./);
    // Its memory and disk come from that computer; Milagre's amount lives in the bar's hover, and the computer's own page
    // opens with what Milagre uses there.
    await waitFor(`!!document.querySelector('[data-computer-settings] [data-resource-meter=disk]')`);
    assert.equal(await text("[data-computer-settings] [data-resource-meter=memory]"), "20 GBfree of 32 GB");
    assert.equal(await text("[data-computer-settings] [data-resource-meter=disk]"), "1.5 TBfree of 2 TB");
    assert.match(
      await evaluate(`document.querySelector('[data-computer-settings] [data-resource-bar=memory]').getAttribute('aria-label')`),
      /Milagre 2 GB · Other apps 10 GB/,
    );
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-computer-settings] [data-resource-parts] li')].map((item) => item.textContent)`), [
      "Claude · 2 agents1.5 GB",
      "Milagre app512 MB",
      "Worktrees · 1275 GB",
      "App data5 GB",
    ]);
    // Auto update flips on that computer, through its own calls.
    await waitFor(`document.querySelector('[data-computer-auto-update] [role=checkbox]')?.getAttribute('aria-checked') === 'false'`);
    await evaluate(`document.querySelector('[data-computer-auto-update] [role=checkbox]').click()`);
    await waitFor(
      `window.autoSaves.length === 1 && document.querySelector('[data-computer-auto-update] [role=checkbox]').getAttribute('aria-checked') === 'true'`,
    );
    assert.deepEqual(await evaluate("window.autoSaves"), [["c-arketa", true]]);
    // Its desktop app's update: Install & restart asks first, since it restarts Milagre over there.
    await waitFor(`document.querySelector('[data-computer-update]')?.dataset.computerUpdate === 'downloaded'`);
    assert.match(await text("[data-computer-update]"), /^Update available: v0\.122\.0arketa runs Milagre 0\.121\.0\. Milagre 0\.122\.0 is ready to install\./);
    await evaluate(`document.querySelector('[data-computer-update-install]').click()`);
    await waitFor(`!!document.querySelector('[data-computer-update-confirm]')`);
    assert.match(
      await text("[data-computer-update]"),
      /Restart Milagre on arketa to install v0\.122\.0\? Running Chats are saved and resume after the restart\./,
    );
    assert.deepEqual(await evaluate("window.installs"), [], "nothing restarts before the answer");
    await screenshot("computer-update-confirm");
    await evaluate(`document.querySelector('[data-computer-update-confirm]').click()`);
    await waitFor(`window.installs.length === 1 && document.querySelector('[data-computer-update]')?.dataset.computerUpdate === 'installing'`);
    assert.match(await text("[data-computer-update]"), /Restarting…$/);
    await screenshot("computer-settings");
    console.log("PASS: a computer's settings show its connection routes, which is in use, what lives there, its memory and disk and its app update");

    window.webContents.focus();
    await evaluate(`(() => {
      const input = document.querySelector('[data-computer-settings] input[aria-label="Name"]');
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "lab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    })()`);
    await waitFor(`window.renames.length === 1 && document.querySelector('h1')?.textContent === 'lab'`);
    assert.deepEqual(await evaluate(`window.renames`), [["c-arketa", "lab"]]);
    console.log("PASS: the name is a label on this Mac, saved when the field is left");

    await evaluate(`${nav("studio")}.click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'studio'`);
    assert.match(await text("[data-computer-projects]"), /^studio is offline/);
    assert.match(await text("[data-computer-status]"), /^Offline, seen 2h ago/);
    assert.equal(await text('[data-connection="lan"] [data-connection-state]'), "Not available");
    await evaluate(`document.querySelector('[data-computer-remove]').click()`);
    await waitFor(`!!document.querySelector('[data-computer-remove-confirm]')`);
    assert.match(
      await text("[data-computer-settings]"),
      new RegExp(`Its chats leave this sidebar and ${thisComputer} forgets its keys\\. Nothing changes on studio; pair again with a new link\\.`),
    );
    await screenshot("computer-settings-remove");
    await evaluate(`document.querySelector('[data-computer-remove-confirm]').click()`);
    await waitFor(`window.removed.length === 1 && window.sectionAfter === 'devices'`);
    assert.deepEqual(await evaluate(`window.removed`), ["c-studio"]);
    assert.deepEqual(errors, []);
    console.log("PASS: Remove asks once more, removes the computer and goes to Settings › Devices");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    await screenshot("failure").catch(() => {});
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-computer-settings"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "computer-settings-fixture",
        resolveId(id) {
          if (id === "/__computer-settings.tsx") return id;
        },
        load(id) {
          if (id === "/__computer-settings.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__computer-settings") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__computer-settings.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__computer-settings`], {
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
