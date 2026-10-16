// Settings > Experimental in Electron: the section is listed and its switch turns the every-Project sidebar on and off.
// Picking a notification chime saves it and plays it; the replay button plays it again.
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
import '/src/styles.css';
window.enabledCalls = [];
// Chimes record what would play instead of making noise.
window.played = [];
HTMLMediaElement.prototype.play = function () { window.played.push(this.src.split('/').pop().split('?')[0]); return Promise.resolve(); };
window.savedShare = { id: "orphan", url: "https://share.milagre.cloud/s/orphan", title: "Deleted Chat page", createdAt: 1780000000000, designCount: 2 };
window.shareCalls = [];
window.botsSaves = [];
window.milagre = {
  listEditors: async () => [],
  listRecentProjects: async () => [],
  listProjects: async () => [],
  readDesignsEnabled: async () => ({ enabled: true }),
  saveDesignsEnabled: async (enabled) => ({ enabled }),
  onDesignsEnabledChanged: () => () => {},
  readBotsEnabled: async () => ({ enabled: false }),
  saveBotsEnabled: async (enabled) => { window.botsSaves.push(enabled); return { enabled }; },
  onBotsEnabledChanged: () => () => {},
  listBots: async () => ({ enabled: false, bots: [], gates: [], grants: [], chats: [] }),
  onBotsChanged: () => () => {},
  artifacts: {
    allPageShares: async () => { window.shareCalls.push(["all"]); return [window.savedShare]; },
    revokeSavedPageShare: async ({ id }) => { window.shareCalls.push(["revoke", id]); window.savedShare = { ...window.savedShare, revoked: true }; },
    pageShares: async () => { throw new Error("No Chat exists"); },
  },
  computers: { setEnabled: async (on) => void window.enabledCalls.push(on) },
};
function Fixture() {
  const [section, setSection] = useState('appearance');
  const { legacySidebar, otherComputers } = useSettings();
  useApplyOtherComputers();
  return (
    <div data-legacy-sidebar={String(legacySidebar)} data-other-computers={String(otherComputers)} style={{ display: 'flex', gap: 12, height: '100vh', padding: 12 }}>
      <SettingsNav section={section} onSelect={setSection} onSelectProject={() => {}} onBack={() => {}} showProjectSettings={false} />
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section={section} models={[]} update={null} /></main>
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
    await waitFor(`${designsSetting}.querySelector('[role="switch"][aria-label="Designs"]').getAttribute("aria-checked") === "false"`);
    assert.equal(await evaluate(`${designsSetting}.textContent.includes("Published pages")`), true, "all public links remain manageable while Designs is off");
    await evaluate(`[...${designsSetting}.querySelectorAll("button")].find((b) => b.textContent === "Manage").click()`);
    await waitFor(`${shareDialog}?.open && ${shareDialog}.textContent.includes("Deleted Chat page")`);
    await screenshot("published-pages-designs-off");
    await evaluate(`[...${shareDialog}.querySelectorAll("button")].find((b) => b.textContent === "Close").click()`);
    await waitFor(`!${shareDialog}`);
    await evaluate(`${designsSetting}.querySelector('[role="switch"][aria-label="Designs"]').click()`);
    await waitFor(`${designsSetting}.textContent.includes("Published pages")`);
    const botsSwitch = 'document.querySelector("[data-slot=bots-setting] [role=switch][aria-label=Bots]")';
    await waitFor(`${botsSwitch} && !${botsSwitch}.disabled`);
    assert.equal(
      await evaluate(`[...document.querySelectorAll("h2, h3")].find((h) => h.textContent.trim() === "Beta")?.parentElement.contains(${botsSwitch})`),
      true,
      "Bots sits in the Beta group",
    );
    assert.equal(await evaluate(`${botsSwitch}.getAttribute("aria-checked")`), "false", "Bots is off by default");
    assert.equal(
      await evaluate(
        'document.querySelector("[data-slot=bots-setting]").textContent.includes("Named bots that work for you and ask before anything irreversible.")',
      ),
      true,
    );
    await evaluate(`${botsSwitch}.click()`);
    await waitFor(`${botsSwitch}.getAttribute("aria-checked") === "true"`);
    assert.deepEqual(await evaluate("window.botsSaves"), [true]);
    await screenshot("bots-on");
    await evaluate(`${toggle}.click()`);
    await waitFor(`document.querySelector('[data-legacy-sidebar]').dataset.legacySidebar === 'true'`);
    await screenshot("on");
    await evaluate(`${toggle}.click()`);
    await waitFor(`document.querySelector('[data-legacy-sidebar]').dataset.legacySidebar === 'false'`);
    assert.equal(await evaluate(`!!document.querySelector('[aria-label="Murilo mode"]')`), false, "Murilo mode moved to Settings › Chat");
    const other = `document.querySelector('[role="switch"][aria-label="Other computers"]')`;
    assert.equal(await evaluate(`document.querySelector('[data-other-computers]').dataset.otherComputers`), "false", "Other computers is off by default");
    await waitFor(`JSON.stringify(window.enabledCalls) === '[false]'`);
    await evaluate(`${other}.click()`);
    await waitFor(`document.querySelector('[data-other-computers]').dataset.otherComputers === 'true'`);
    await waitFor(`JSON.stringify(window.enabledCalls) === '[false,true]'`);
    await screenshot("other-computers-on");
    await evaluate(`${other}.click()`);
    await waitFor(`JSON.stringify(window.enabledCalls) === '[false,true,false]'`);
    const chimeTrigger = `document.querySelector('button[aria-label="Notification chime"]')`;
    assert.equal(await evaluate(`${chimeTrigger}.textContent.trim()`), "System default", "the system sound by default");
    assert.equal(await evaluate(`!!document.querySelector("[data-chime-play]")`), false, "nothing to replay for the system sound");
    await evaluate(`${chimeTrigger}.scrollIntoView({ block: "center" })`);
    await evaluate(`${chimeTrigger}.click()`);
    const chimeOption = (label) =>
      `[...document.querySelectorAll('[role="listbox"][aria-label="Notification chime"] [role="option"]')].find((o) => o.textContent.trim() === ${JSON.stringify(label)})`;
    await waitFor(`!!${chimeOption("Miracle")}`);
    await screenshot("chime-menu");
    await evaluate(`${chimeOption("Miracle")}.click()`);
    await waitFor(`${chimeTrigger}.textContent.trim() === "Miracle"`);
    assert.equal(await evaluate("window.played.length"), 1, "picking a chime plays it");
    assert.match(await evaluate("window.played[0]"), /^chime_miracle/);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem("milagre-settings")).notificationChime`), "miracle", "and saves it");
    await screenshot("chime-miracle");
    await evaluate(`document.querySelector("[data-chime-play]").click()`);
    await evaluate(`${chimeTrigger}.click()`);
    await waitFor(`!!${chimeOption("Bombastic side eye")}`);
    await evaluate(`${chimeOption("Bombastic side eye")}.click()`);
    await waitFor(`${chimeTrigger}.textContent.trim() === "Bombastic side eye"`);
    assert.equal(await evaluate("window.played.length"), 3, "the replay button plays it again, and each pick plays");
    assert.match(await evaluate("window.played[2]"), /^chime_bombastic_side_eye/);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Settings lists an Experimental section with a Bots switch, off by default, that saves on the host, and a switch that turns the every-Project sidebar on and off, off by default, with no Murilo mode; Other computers is off by default and tells main each time it flips; the notification chime starts on the system sound, and picking one saves and plays it",
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
