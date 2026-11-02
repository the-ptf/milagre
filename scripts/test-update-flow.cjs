// Browser check: Settings > About lets the user pick the Beta release channel and hands the choice to the main process.
// With a Chat open, the update pill floats centred above the composer, on the chip row's line.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { UpdateShell, useAppUpdates, UpdateSettingsBadge } from "/src/components/UpdateNotice";
import { AboutSettings } from "/src/components/Settings";
import { ChatComposer } from "/src/components/ChatComposer";
import SidebarNav from "/src/components/SidebarNav";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
let listener;
window.__installs = 0;
window.__checks = 0;
window.__state = { status: "downloading", version: "1.2.3", progress: 42 };
window.__update = (state) => { window.__state = state; listener(state); };
window.milagre = {
  getAppVersion: async () => "1.2.2", getReleaseChannel: async () => "stable",
  getUpdateState: async () => window.__state,
  getUpdateReleaseNotes: async (version) => {
    if (window.__notesFail) throw new Error("offline");
    return window.__notesEmpty ? "" : "## Changes in v" + version + "\\n\\n- Keep downloading the latest update.\\n- Read release notes inside Milagre.";
  },
  onUpdateState: (cb) => { listener = cb; return () => {}; },
  installUpdate: async () => { window.__installs++; window.__update({ ...window.__state, status: "installing" }); },
  checkForUpdates: async () => { window.__checks++; window.__update({ ...window.__state, status: "checking" }); },
  readAutoUpdate: async () => ({ autoUpdate: window.__autoUpdate ?? false }),
  saveAutoUpdate: async (value) => { window.__autoUpdate = value; window.__autoListener?.({ autoUpdate: value }); return { autoUpdate: value }; },
  onAutoUpdate: (cb) => { window.__autoListener = cb; return () => {}; },
  listRecentProjects: async () => [], listNamedLinks: async () => [], listProjects: async () => [],
  getProjectImage: async () => null, listEditors: async () => [],
  onProjectState: () => () => {}, onLinkState: () => () => {},
};
document.documentElement.classList.add("dark");
function Settings() { return <AboutSettings update={useAppUpdates()} />; }
const noop = () => {};
const model = MODEL_CATALOG[0];
const messages = [
  { id: 1, session_id: 1, context: null, role: "user", body: "Review authentication and run the relevant tests." },
  { id: 2, session_id: 1, context: null, role: "assistant", body: "I started a subagent. Its progress is available below." },
];
const subagents = [{ id: "review", title: "Review authentication", status: "running", startedAt: Date.now(), updatedAt: Date.now(), transcript: [] }];
function Chat() {
  return <div className="flex h-full flex-col text-ink"><ChatComposer messages={messages}
    imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
    projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={true} sendBlocked={false} subagents={subagents}
    models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
    capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
    fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
    onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
    isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} /></div>;
}
function Fixture() {
  const [chat, setChat] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  window.__chat = setChat;
  window.__sidebar = setSidebar;
  const settings = <div style={{ maxWidth: 640, margin: "60px auto" }}><Settings /></div>;
  if (sidebar) return <div className="flex h-screen gap-3 p-3 pt-12">
    <SidebarNav fill workspaceName="Milagre" projectPath="/fixture" recents={[]} onOpenSettings={() => setChat(false)} />
    <div className="min-w-0 flex-1">{chat ? <Chat /> : settings}</div>
  </div>;
  // The app keeps the Chat mounted but hidden while Settings is open.
  if (chat === "hidden") return <><div className="hidden" style={{ height: "100vh" }}><Chat /></div>{settings}</>;
  return chat ? <div style={{ height: "100vh" }}><Chat /></div> : settings;
}
function App() {
  const [sidebar, setSidebar] = useState(false);
  window.__showSidebar = () => { setSidebar(true); window.__sidebar(true); window.__chat(true); };
  return <UpdateShell>{!sidebar && <button data-update-settings aria-label="Settings" className="fixed right-4 top-4" onClick={() => window.__chat(false)}>Settings<UpdateSettingsBadge /></button>}<Fixture /></UpdateShell>;
}
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({
    width: 900,
    height: 520,
    show: false,
    webPreferences: { backgroundThrottling: false, partition: "update-flow-check" },
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const screenshot = async (name) => {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await delay(200);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const button = (label) => `[...document.querySelectorAll('button')].find(n => n.textContent.trim() === ${JSON.stringify(label)})`;
  try {
    await window.loadURL(process.argv[2]);
    await waitFor("document.body.innerText.includes('Downloading update')");
    await screenshot("update-downloading-pill");
    assert.equal(await evaluate(`!!document.querySelector('[data-face=pill] [aria-label="Dismiss update"]')`), false);
    await evaluate(`${button("Downloading update · 42%")}.click()`);
    await waitFor("!!document.querySelector('[role=progressbar]')");
    await screenshot("update-downloading");
    await evaluate("window.__update({ status: 'downloaded', version: '1.2.3', progress: 100 })");
    await waitFor("!!document.querySelector('[aria-label=\"Update available\"]')");
    assert.match(await evaluate("document.body.innerText"), /stop running agents/);
    assert.doesNotMatch(await evaluate("document.body.innerText"), /terminal/i);
    await evaluate(`${button("What's new")}.click()`);
    await waitFor("!!document.querySelector('dialog[open]') && document.body.innerText.includes('Changes in v1.2.3')");
    await screenshot("update-release-notes");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor("!document.querySelector('dialog[open]')");
    assert.equal(await evaluate("document.activeElement.textContent.trim()"), "What's new");
    await evaluate("window.__notesFail = true");
    await evaluate(`${button("What's new")}.click()`);
    await waitFor("document.querySelector('dialog')?.innerText.includes('Could not load release notes')");
    await evaluate("window.__notesFail = false; document.querySelector('dialog [role=alert] button').click()");
    await waitFor("document.querySelector('dialog')?.innerText.includes('Changes in v1.2.3')");
    await evaluate(`document.querySelector('[aria-label="Close release notes"]').click()`);
    await screenshot("update-ready-dark");
    await evaluate("document.documentElement.classList.remove('dark')");
    await screenshot("update-ready-light");
    await evaluate("document.documentElement.classList.add('dark'); document.querySelector('[aria-label=\"Dismiss update\"]').click()");
    await waitFor("!document.querySelector('[role=dialog]')");
    assert.equal(await evaluate("!!document.querySelector('[data-update-notice]')"), false);
    assert.ok(await evaluate(`document.querySelector('[data-update-settings] [aria-label="Update available"]')`));
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Settings");
    // Repeated download events must not undo dismissal.
    await evaluate("window.__update({ status: 'downloaded', version: '1.2.3', progress: 100 })");
    await delay(100);
    assert.equal(await evaluate("!!document.querySelector('[role=dialog]')"), false);
    await screenshot("update-dismissed");
    // Settings installation also goes through the agent-stop warning.
    await evaluate(`${button("Install & restart")}.click()`);
    await waitFor("!!document.querySelector('[role=dialog]')");
    assert.equal(await evaluate("window.__installs"), 0);
    await evaluate("document.querySelector('[role=dialog] button[data-install]').click()");
    await waitFor("document.body.innerText.includes('Restarting Milagre')");
    assert.equal(await evaluate("window.__installs"), 1);
    await screenshot("update-installing");
    await evaluate("window.__update({ status: 'downloaded', version: '1.2.3', progress: 100, error: 'Could not restart Milagre. Try again.' })");
    await waitFor("!!document.querySelector('[role=alert]')");
    await screenshot("update-install-error");
    await evaluate("window.__update({ status: 'error', version: '1.2.4', progress: 12, error: 'Could not download the update. Try again.' })");
    await waitFor("document.body.innerText.includes('Could not download')");
    await screenshot("update-download-error");
    await evaluate(`${button("Try again")}.click()`);
    await waitFor("window.__checks === 1");
    await evaluate("window.__update({ status: 'downloaded', version: '1.2.4', progress: 100 })");
    await waitFor("document.body.innerText.includes('v1.2.4 is ready')");
    // Auto update: the switch in About saves on the host; with it on, the ready card says the update installs by itself.
    const autoSwitch = `document.querySelector('[role=checkbox][aria-label="Auto update"]')`;
    await waitFor(`${autoSwitch}?.getAttribute('aria-checked') === 'false'`);
    assert.match(await evaluate("document.body.innerText"), /nobody has used the Mac for 5 minutes/);
    await evaluate(`${autoSwitch}.click()`);
    await waitFor(`window.__autoUpdate === true && ${autoSwitch}.getAttribute('aria-checked') === 'true'`);
    await evaluate("window.__update({ status: 'downloaded', version: '1.2.4', progress: 100, auto: true })");
    await waitFor("document.body.innerText.includes('Auto update is on')");
    assert.doesNotMatch(await evaluate("document.body.innerText"), /stop running agents/);
    assert.match(await evaluate("document.body.innerText"), /Auto update installs it once nothing is running/);
    await screenshot("update-auto");
    // Turned off from another device: the switch follows.
    await evaluate("window.__autoListener({ autoUpdate: false })");
    await waitFor(`${autoSwitch}.getAttribute('aria-checked') === 'false'`);
    await evaluate("window.__update({ status: 'downloaded', version: '1.2.4', progress: 100, auto: false })");
    await waitFor("document.body.innerText.includes('stop running agents')");
    // Escape returns keyboard focus to the persistent trigger.
    await evaluate("document.querySelector('[role=dialog] button').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor("!document.querySelector('[role=dialog]')");
    assert.equal(await evaluate("document.activeElement.textContent.trim()"), "Update available");
    await evaluate(`${button("Update available")}.click()`);
    await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    await waitFor("!document.querySelector('[role=dialog]')");
    // An open Chat holds the pill centred above its composer, bottom-aligned with the chip row, outside the row's flow.
    await evaluate("window.__chat(true)");
    await waitFor("[...document.querySelectorAll('button')].some(n => n.textContent.includes('Subagents'))");
    const placement = await evaluate(`(() => {
      const pill = ${button("Update available")}.closest('[data-face=pill]').getBoundingClientRect();
      const chip = [...document.querySelectorAll('button')].find(n => n.textContent.includes('Subagents')).getBoundingClientRect();
      const column = document.querySelector('[data-prompt-editor]').closest('[data-composer-wrap]').getBoundingClientRect();
      return { pillCenter: (pill.left + pill.right) / 2, columnCenter: (column.left + column.right) / 2, pillBottom: pill.bottom, chipBottom: chip.bottom, fixed: getComputedStyle(${button("Update available")}.closest("[data-update-notice]")).position };
    })()`);
    assert.ok(Math.abs(placement.pillCenter - placement.columnCenter) < 1, `pill is centred: ${JSON.stringify(placement)}`);
    assert.ok(Math.abs(placement.pillBottom - placement.chipBottom) < 1, `pill shares the chip row's line: ${JSON.stringify(placement)}`);
    assert.notEqual(placement.fixed, "fixed");
    await screenshot("update-pill-chat");
    await evaluate(`${button("Update available")}.click()`);
    await waitFor("!!document.querySelector('[role=dialog]')");
    // The pill morphs into the card in its own spot instead of opening a card above it.
    await waitFor(`getComputedStyle(${button("Update available")}).visibility === "hidden" && ${button("Update available")}.closest('[data-face=pill]').inert`);
    await delay(600);
    const card = await evaluate(`(() => {
      const card = document.querySelector('[data-update-notice] > div').getBoundingClientRect();
      return { center: (card.left + card.right) / 2, bottom: card.bottom, width: card.width };
    })()`);
    assert.ok(Math.abs(card.center - placement.columnCenter) < 1, `card is centred: ${JSON.stringify(card)}`);
    assert.ok(Math.abs(card.bottom - placement.pillBottom) < 1, `card grows from the pill's line: ${JSON.stringify(card)}`);
    assert.ok(Math.abs(card.width - 360) < 1, `card reaches full width: ${JSON.stringify(card)}`);
    await screenshot("update-pill-chat-open");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor("!document.querySelector('[role=dialog]')");
    assert.equal(await evaluate("document.activeElement.textContent.trim()"), "Update available");
    // Leaving the Chat returns the pill to the window's bottom left.
    await evaluate("window.__chat(false)");
    await waitFor(`getComputedStyle(${button("Update available")}.closest("[data-update-notice]")).position === 'fixed'`);
    // A Chat hidden behind Settings gives the pill up, so Install & restart opens a card that is on screen.
    await evaluate("window.__chat('hidden')");
    await waitFor(`!!${button("Install & restart")}`);
    await waitFor(`getComputedStyle(${button("Update available")}.closest("[data-update-notice]")).position === 'fixed'`);
    await evaluate(`${button("Install & restart")}.click()`);
    await waitFor("document.querySelector('[role=dialog]')?.getClientRects().length > 0");
    await screenshot("update-settings-hidden-chat");
    // showUpdateNotice moves focus on the next animation frame; Escape must reach the card.
    await waitFor("document.querySelector('[role=dialog]')?.contains(document.activeElement)");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor("!document.querySelector('[role=dialog]')");
    await waitFor("getComputedStyle(document.querySelector('[data-face=pill]')).visibility === 'visible'");
    assert.equal(await evaluate(`!!document.querySelector('[data-face=pill] [aria-label="Dismiss update"]')`), false);
    await evaluate(`${button("Update available")}.click()`);
    await waitFor("getComputedStyle(document.querySelector('[data-face=card]')).visibility === 'visible'");
    await evaluate(`document.querySelector('[role=dialog] [aria-label="Dismiss update"]').focus()`);
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Dismiss update");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await waitFor("!document.querySelector('[data-update-notice]')");
    assert.ok(await evaluate(`document.querySelector('[data-update-settings] [aria-label="Update available"]')`));
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Settings");
    await evaluate("window.__showSidebar()");
    await waitFor(`!!document.querySelector('aside [data-update-settings] [aria-label="Update available"]')`);
    const badgeInsideSettings = `(() => {
      const button = document.querySelector('aside [data-update-settings]');
      const badge = button.querySelector('[aria-label="Update available"]');
      const gear = button.getBoundingClientRect(), dot = badge.getBoundingClientRect();
      return badge.checkVisibility() && dot.width > 0 && dot.height > 0 && dot.left >= gear.left && dot.right <= gear.right && dot.top >= gear.top && dot.bottom <= gear.bottom;
    })()`;
    assert.ok(await evaluate(badgeInsideSettings), "Update dot is visible inside the actual sidebar Settings gear");
    if (await evaluate(`!!document.querySelector('[aria-label="Expand sidebar"]')`)) {
      await evaluate(`document.querySelector('[aria-label="Expand sidebar"]').click()`);
    }
    const sidebarSettled = `(() => {
      const sidebar = document.querySelector('aside[data-sidebar-collapsed]');
      return Math.abs(sidebar.getBoundingClientRect().width - parseFloat(sidebar.style.width)) < 1;
    })()`;
    await waitFor(sidebarSettled);
    await screenshot("update-sidebar-expanded");
    await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`);
    await waitFor(`!!document.querySelector('[aria-label="Expand sidebar"]')`);
    await waitFor(sidebarSettled);
    assert.ok(await evaluate(badgeInsideSettings), "Update dot remains on the collapsed sidebar Settings gear");
    await screenshot("update-sidebar-collapsed");
    console.log("PASS: update pill above the chat composer morphs into the card in place, falling back to the bottom left without a visible Chat");
    console.log("PASS: update progress, ready card, dismissal, settings warning, installation, retries and keyboard access");
    console.log("PASS: Auto update switch in About saves, follows other devices, and changes the ready card's line");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "update-flow-fixture",
        resolveId(id) {
          if (id === "/__update_flow_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__update_flow_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__update_flow__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__update_flow_fixture.tsx"></script></body></html>',
            );
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__update_flow__`], { env, stdio: "inherit" });
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
  process.exitCode = 1;
});
