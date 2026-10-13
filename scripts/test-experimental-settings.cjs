// Settings > Experimental in Electron: the section is listed, its switch turns the every-Project sidebar on and off,
// and Murilo mode shows a reply's tool calls in the chat, one row each, instead of folding them into one line.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsNav, SettingsPanel } from '/src/components/Settings';
import { useSettings } from '/src/lib/settings';
import { useApplyOtherComputers } from '/src/lib/computers';
import { ActivityBlock } from '/src/components/agents/ActivityBlock';
import '/src/styles.css';
window.enabledCalls = [];
window.savedShare = { id: "orphan", url: "https://share.milagre.cloud/s/orphan", title: "Deleted Chat page", createdAt: 1780000000000, designCount: 2 };
window.shareCalls = [];
window.milagre = {
  listEditors: async () => [],
  listRecentProjects: async () => [],
  listProjects: async () => [],
  readDesignsEnabled: async () => ({ enabled: true }),
  saveDesignsEnabled: async (enabled) => ({ enabled }),
  onDesignsEnabledChanged: () => () => {},
  artifacts: {
    allPageShares: async () => { window.shareCalls.push(["all"]); return [window.savedShare]; },
    revokeSavedPageShare: async ({ id }) => { window.shareCalls.push(["revoke", id]); window.savedShare = { ...window.savedShare, revoked: true }; },
    pageShares: async () => { throw new Error("No Chat exists"); },
  },
  computers: { setEnabled: async (on) => void window.enabledCalls.push(on) },
};
const step = (id, title, kind = 'shell') => ({ id, kind, title, status: 'done', note: '1s' });
const entries = [
  { type: 'step', step: step('a', 'Ran \`npm test\`') },
  { type: 'text', text: 'Tests pass. Checking the build next.' },
  { type: 'step', step: step('b', 'Read \`package.json\`', 'read') },
  { type: 'step', step: step('c', 'Searched for \`muriloMode\`', 'search') },
];
function Fixture() {
  const [section, setSection] = useState('appearance');
  const { legacySidebar, otherComputers } = useSettings();
  useApplyOtherComputers();
  return (
    <div data-legacy-sidebar={String(legacySidebar)} data-other-computers={String(otherComputers)} style={{ display: 'flex', gap: 12, height: '100vh', padding: 12 }}>
      <SettingsNav section={section} onSelect={setSection} onSelectProject={() => {}} onBack={() => {}} showProjectSettings={false} />
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section={section} models={[]} update={null} /></main>
      <aside data-reply style={{ width: 320 }}><ActivityBlock entries={entries} /></aside>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-experimental-settings-")));
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
  const toggle = `document.querySelector('[role="switch"][aria-label="Use legacy sidebar"], button[aria-label="Use legacy sidebar"], input[aria-label="Use legacy sidebar"]')`;
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Experimental')`);
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Experimental').click()`);
    await waitFor(`!!${toggle}`);
    assert.equal(
      await evaluate(`document.querySelector('[data-legacy-sidebar]').dataset.legacySidebar`),
      "false",
      "Off by default: every project in the sidebar",
    );
    await screenshot("off");
    const designsSetting = 'document.querySelector("[data-slot=designs-setting]")';
    await waitFor(`${designsSetting}.textContent.includes("Published pages")`);
    await evaluate(`[...${designsSetting}.querySelectorAll("button")].find((b) => b.textContent === "Manage").click()`);
    const shareDialog = 'document.querySelector("[data-slot=design-page-share]")';
    await waitFor(`${shareDialog}?.open && ${shareDialog}.textContent.includes("Deleted Chat page")`);
    assert.equal(await evaluate(`${shareDialog}.querySelector("[data-slot=design-page-publish]") === null`), true, "global manager has no publication action");
    assert.deepEqual(await evaluate("window.shareCalls"), [["all"]], "deleted Chat history requires no Chat or service health call");
    await screenshot("published-pages-orphan");
    await evaluate(`[...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Revoke link").click()`);
    await evaluate(`${shareDialog}.querySelector("[data-slot=design-page-revoke-confirm]").click()`);
    await waitFor(`${shareDialog}.textContent.includes("Revoked")`);
    assert.deepEqual(await evaluate("window.shareCalls"), [["all"], ["revoke", "orphan"]]);
    await screenshot("published-pages-orphan-revoked");
    await evaluate(`[...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Close").click()`);
    await waitFor(`!${shareDialog}`);
    await evaluate(`${designsSetting}.querySelector('[role="switch"][aria-label="Designs"]').click()`);
    await waitFor(`!${designsSetting}.textContent.includes("Published pages")`);
    await evaluate(`${designsSetting}.querySelector('[role="switch"][aria-label="Designs"]').click()`);
    await waitFor(`${designsSetting}.textContent.includes("Published pages")`);
    await evaluate(`${toggle}.click()`);
    await waitFor(`document.querySelector('[data-legacy-sidebar]').dataset.legacySidebar === 'true'`);
    await screenshot("on");
    await evaluate(`${toggle}.click()`);
    await waitFor(`document.querySelector('[data-legacy-sidebar]').dataset.legacySidebar === 'false'`);
    const murilo = `document.querySelector('[role="switch"][aria-label="Murilo mode"], button[aria-label="Murilo mode"], input[aria-label="Murilo mode"]')`;
    const reply = (selector) => `document.querySelector('[data-reply] ${selector}')`;
    assert.equal(await evaluate(`!!${reply("[data-slot=activity]")}`), true, "Murilo mode is off by default: the activity folds into one line");
    assert.equal(await evaluate(`!!${reply("[data-slot=activity-inline]")}`), false);
    await evaluate(`${murilo}.click()`);
    await waitFor(`!!${reply("[data-slot=activity-inline]")}`);
    assert.equal(await evaluate(`!!${reply("[data-slot=activity]")}`), false, "Murilo mode leaves no fold");
    const text = await evaluate(`${reply("[data-slot=activity-inline]")}.innerText`);
    for (const shown of ["npm test", "Tests pass. Checking the build next.", "package.json", "muriloMode"])
      assert.ok(text.includes(shown), `shows ${shown} in the chat`);
    assert.ok(text.indexOf("npm test") < text.indexOf("Tests pass") && text.indexOf("Tests pass") < text.indexOf("package.json"), "in order");
    await screenshot("murilo-on");
    await evaluate(`${murilo}.click()`);
    await waitFor(`!!${reply("[data-slot=activity]")}`);
    const other = `document.querySelector('[role="switch"][aria-label="Other computers"]')`;
    assert.equal(await evaluate(`document.querySelector('[data-other-computers]').dataset.otherComputers`), "false", "Other computers is off by default");
    await waitFor(`JSON.stringify(window.enabledCalls) === '[false]'`);
    await evaluate(`${other}.click()`);
    await waitFor(`document.querySelector('[data-other-computers]').dataset.otherComputers === 'true'`);
    await waitFor(`JSON.stringify(window.enabledCalls) === '[false,true]'`);
    await screenshot("other-computers-on");
    await evaluate(`${other}.click()`);
    await waitFor(`JSON.stringify(window.enabledCalls) === '[false,true,false]'`);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Settings lists an Experimental section whose switches turn the every-Project sidebar and Murilo mode on and off, both off by default; Murilo mode shows each tool call and the notes between them in order, with no fold; Other computers is off by default and tells main each time it flips",
    );
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
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-experimental-settings"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "experimental-settings-fixture",
        resolveId(id) {
          if (id === "/__experimental-settings.tsx") return id;
        },
        load(id) {
          if (id === "/__experimental-settings.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__experimental-settings") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__experimental-settings.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(
      require("electron"),
      [path.resolve(__filename), `${server.resolvedUrls.local[0]}__experimental-settings`],
      {
        env,
        stdio: "inherit",
      },
    );
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
