// Run with npm test -- --only test-sidebar-computers. The footer's computers popover in the real App against a stand-in for
// main: the laptop button opens a popover of This Mac and each computer with its route line, a gear with its tooltip
// opens that computer's settings (This Mac's opens Settings › Devices), unchecking a computer leaves its Projects out of
// the sidebar and Filters › Projects (kept across a restart), Filters › Projects lists Projects under their computer, Add computer opens its
// dialog from the popover and from Settings › Devices, and nothing about computers shows while Settings › Devices ›
// Other computers is off. Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { thisComputer, ThisComputer } = require("@milagre/shared/host-computer");

const fixture = `
localStorage.setItem("milagre.hiddenRemoteScopes", JSON.stringify(["c-atlas|/Users/a/old-site"]));
import React from "react";
import { createRoot } from "react-dom/client";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const HOUR = 3600000;
const local = { next_id: 3, projects: { 1: { id: 1, name: "milagre-ade" } }, worktrees: { 1: { id: 1, name: "main", path: "/work/milagre-ade", project_id: 1 } }, sessions: { 2: { id: 2, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title: "Desktop connect sidebar" } }, connections: {}, events: [], messages: [{ id: 2, session_id: 2, role: "user", body: "Connect the sidebar" }], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
window.computerList = [
  { id: "c-atlas", name: "atlas", hostId: "a".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: 1, message: null, lan: true, lanRoutes: ["ws://192.168.0.24:8798"] },
  { id: "c-studio", name: "studio", hostId: "s".repeat(22), relayHost: "relay.milagre.cloud", state: "offline", route: null, lastSeen: Date.now() - 2 * HOUR, addedAt: 1, message: null, lan: false, lanRoutes: [] },
];
const computerListeners = new Set();
const computersChanged = (snapshot) => { for (const listener of computerListeners) listener(snapshot); };
window.computerEnableCalls = [];
const daemonSettings = location.search.includes("daemon=1");
let daemonEnabled = true;
window.setDaemonEnabled = (enabled) => {
  daemonEnabled = enabled;
  computersChanged({ thisMac: "victor-mbp", computers: window.computerList, enabled });
};
window.setChatList = (chatList) => updateSettings({ chatList });
const computerEvents = new Set();
window.setComputers = (list) => { window.computerList = list; computersChanged({ thisMac: "victor-mbp", computers: list }); };
const remoteState = (title, body) => ({ next_id: 9, projects: { 1: { id: 1, name: "p" } }, worktrees: { 1: { id: 1, name: "main", path: "/remote", project_id: 1 } }, sessions: { 4: { id: 4, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title } }, connections: {}, events: [], messages: [{ id: 4, session_id: 4, role: "user", body }], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] });
const remoteProjects = {
  // Hidden on atlas's own sidebar, but shown on this Mac because each computer has its own visibility.
  "c-atlas": { path: "c-atlas|/Users/a/atlas-web", name: "atlas-web", hidden: true, state: remoteState("Fix flaky deploy check", "The deploy check fails about one run in five.") },
  "c-studio": { path: "c-studio|/Users/s/homelab", name: "homelab", state: remoteState("Backup rotation", "Rotate the nightly backups.") },
  // Shown on atlas, but hidden on this Mac (in milagre.hiddenRemoteScopes): not in the sidebar, and unchecked in Filters › Projects.
  "c-atlas-hidden": { path: "c-atlas|/Users/a/old-site", name: "old-site", state: remoteState("Old site", "Retire it.") },
  // Only on a computer added during the test.
  "c-new": { path: "c-new|/Users/n/garden", name: "garden", state: remoteState("Water plan", "Plan the watering.") },
  "c-studio-lean": {
    path: "c-studio|/Users/s/notes",
    name: "notes",
    // A host that keeps messages by Chat sends none in its state; the Chat's summary lists it in the sidebar.
    state: { ...remoteState("Never opened here", ""), messages: [], messagesInChats: true, sessions: { 4: { id: 4, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title: "Never opened here", summary: { count: 3, firstId: 1, lastId: 3 } } } },
  },
};
window.remoteProjects = remoteProjects;
window.remoteHiddenCalls = 0;
window.sent = [];
// Each computer's bridge, as main would answer it: keys already name the computer.
const projectsOf = (id) => Object.values(remoteProjects).filter((project) => project.path.startsWith(id + "|"));
// A host that numbers states says which state a read carries; the window keeps reads from now on from that number.
const projectAt = async (key) => {
  const project = { ...structuredClone(Object.values(remoteProjects).find((project) => project.path === key)), version: 1, epoch: "fixture-host" };
  if (new URLSearchParams(location.search).has("race") && key === remoteProjects["c-atlas"].path && !window.remoteReadHeld) {
    window.remoteReadHeld = true;
    await new Promise(resolve => { window.finishRemoteRead = resolve; });
  }
  return project;
};
// Each call that opens or reads a remote Project or a Chat's page, in order: [method, key, options or chat id].
window.remoteCalls = [];
// A host that numbers states answers a read with { state: false } with the Project's name and state number alone.
const projectHeader = (key) => {
  const { path, name } = Object.values(remoteProjects).find((project) => project.path === key);
  return { path, name, git: true, version: 1, epoch: "fixture-host" };
};
window.pushRemote = (state) => {
  remoteProjects["c-atlas"].state = state;
  for (const callback of computerEvents) callback({ channel: "project:state", payload: { path: remoteProjects["c-atlas"].path, state } });
};
window.setChatOrder = (chatOrder) => updateSettings({ chatOrder });
window.usageReads = [];
const remoteUsage = (id) => ({ accountKey: id, providers: [{
  provider: "claude", status: "ok", updatedAt: new Date().toISOString(),
  account: { id: "work", label: "Remote work", email: "remote@example.test" },
  windows: [{ id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 37, resetsAt: null }],
}] });
const remote = (id) => new Proxy({
  listRecentProjects: async () => projectsOf(id).map(({ path, name, hidden, origin }) => ({ path, name, ...(hidden ? { hidden } : {}), ...(origin ? { origin } : {}) })),
  setProjectHidden: async () => {
    window.remoteHiddenCalls++;
    throw new Error("Remote computer visibility must not be mutated from this Mac");
  },
  listNamedLinks: async () => [],
  readProject: async (key, options) => {
    window.remoteCalls.push(["readProject", key, options ?? null]);
    return options?.state === false ? projectHeader(key) : projectAt(key);
  },
  switchProject: async (key) => (window.remoteCalls.push(["switchProject", key, null]), projectAt(key)),
  // As main's offline cache answers a chat it kept nothing of (Task 20).
  readChatMessages: async (scope, chatId) => (window.remoteCalls.push(["readChatMessages", scope, chatId]), { messages: [], hasMore: false, total: 0 }),
  getRuns: async () => ({ runs: {}, seq: 0 }),
  listBranches: async () => ["main"],
  getCachedUsage: async () => remoteUsage(id),
  readUsage: async (scope) => { window.usageReads.push([id, scope]); return remoteUsage(id); },
  // A computer answers with its own list; this Mac's must not become it.
  forgetProject: async (key) => ((window.forgotten ??= []).push(key), projectsOf(id).filter((project) => project.path !== key).map(({ path, name }) => ({ path, name }))),
  sendMessage: async (request) => (window.sent.push(request), { sessionId: 4 }),
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
const remotes = { "c-atlas": remote("c-atlas"), "c-studio": remote("c-studio"), "c-new": remote("c-new") };
let localRecent = [{ path: "/work/milagre-ade", name: "milagre-ade" }];
window.setLocalOrigin = (origin) => { localRecent = localRecent.map(({ origin: _origin, ...project }) => (origin ? { ...project, origin } : project)); };
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getCurrentProject: async () => ({ path: "/work/milagre-ade", name: "milagre-ade", state: local }),
  listRecentProjects: async () => localRecent,
  forgetProject: async (key) => (localRecent = localRecent.filter((project) => project.path !== key)),
  // Back to this Mac's Project once Other computers is off (Task 16).
  readProject: async () => ({ path: "/work/milagre-ade", name: "milagre-ade", state: local }),
  switchProject: async () => ({ path: "/work/milagre-ade", name: "milagre-ade", state: local }),
  listBranches: async () => ["main"],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: "idle" }),
  getAppVersion: async () => "0.0.0",
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getRuns: async () => ({ runs: {}, seq: 0 }),
  // A paired computer's bridge: the app asks it for its turns once it is online.
  on: (id) => remotes[id],
  getPhoneStatus: async () => ({ enabled: false, state: "off", remote: "none" }),
  listDevices: async () => [],
  onComputersChanged: (callback) => { computerListeners.add(callback); return () => computerListeners.delete(callback); },
  onComputerEvent: (callback) => (computerEvents.add(callback), () => computerEvents.delete(callback)),
  computers: {
    list: async () => ({ thisMac: "victor-mbp", computers: window.computerList, ...(daemonSettings ? { enabled: daemonEnabled } : {}) }),
    setEnabled: async (enabled) => {
      window.computerEnableCalls.push(enabled);
      if (daemonSettings) window.setDaemonEnabled(enabled);
    },
    invoke: async (id, method) => (method === "daemon:status" ? { version: "0.121.0" } : method === "project:recent" ? [] : null),
    preview: async () => { throw new Error("That isn't a Milagre pairing link. Copy it from Settings › Devices on the other Mac."); },
  },
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
// settings.ts read localStorage when it was imported above, so the saved settings go through its own setter.
updateSettings({ defaultModelId: "claude-opus-5-5", defaultPermissionMode: "ask", otherComputers: !daemonSettings, chatList: "grouped" });
window.setOther = (otherComputers) => updateSettings({ otherComputers });
const { default: App } = await import("/src/App");
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-sidebar-computers-")));
  await app.whenReady();
  // App waits for the splash animation to finish; a shown window keeps its compositor painting under Xvfb.
  const window = new BrowserWindow({ width: 1280, height: 760, show: true, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
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
    const hover = async (selector) => {
      const rect = await evaluate(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(rect.x), y: Math.round(rect.y) });
    };
    const openPopover = async () => {
      await evaluate(`document.querySelector('[data-computers-button]').click()`);
      await waitFor(`!!document.querySelector('[data-computers-panel]')`);
    };
    const lines = () =>
      evaluate(
        `[...document.querySelectorAll('[data-computers-panel] [data-computer-row]')].map((row) => [row.dataset.computerRow, row.querySelector('[data-computer-name]').textContent.trim(), row.querySelector('[data-computer-line]').textContent.trim()])`,
      );
    // A cold Vite dependency scan can reload the full App before its startup animation finishes.
    // Give initial boot its own budget; interaction assertions keep the normal five-second deadline.
    await waitFor(`!!document.querySelector('[data-computers-button]') && !document.querySelector('.startup-splash-screen')`, 20000);
    await openPopover();
    assert.deepEqual(await lines(), [
      ["this-mac", "victor-mbp", ThisComputer],
      ["c-atlas", "atlas", "Same network"],
      ["c-studio", "studio", "Offline, seen 2h ago"],
    ]);
    assert.equal(await evaluate(`!!document.querySelector('[data-computers-panel] [data-add-computer-row]')`), true);
    await screenshot("popover");
    await hover('[data-computer-row="c-atlas"] [data-computer-gear]');
    await waitFor(`[...document.querySelectorAll('[role="tooltip"]')].some((tip) => tip.textContent.includes('atlas settings: rename, connection, remove'))`);
    await screenshot("popover-gear");
    console.log("PASS: the popover lists This Mac, then each computer with its route line, a gear with its tooltip, and Add computer");

    await evaluate(`document.querySelector('[data-computer-row="c-atlas"] [data-computer-gear]').click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'atlas' && !!document.querySelector('[data-computer-settings]')`);
    const sidebarSwitch = `document.querySelector('[data-computer-show-in-sidebar] [role="checkbox"]')`;
    assert.equal(await evaluate(`${sidebarSwitch}.getAttribute('aria-checked')`), "true");
    await evaluate(`${sidebarSwitch}.click()`);
    await waitFor(`${sidebarSwitch}.getAttribute('aria-checked') === 'false'`);
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem("milagre.hiddenComputers") || "[]")`), ["c-atlas"]);
    await evaluate(`${sidebarSwitch}.click()`);
    await waitFor(`${sidebarSwitch}.getAttribute('aria-checked') === 'true' && !localStorage.getItem("milagre.hiddenComputers")`);
    await evaluate(`document.querySelector('[aria-label="Settings navigation"] button[aria-label="Back"]').click()`);
    await waitFor(`!!document.querySelector('[data-computers-button]') && !document.querySelector('.startup-splash-screen')`);
    await openPopover();
    await evaluate(`document.querySelector('[data-computer-row="this-mac"] [data-computer-gear]').click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'Devices'`);
    // Settings › Devices adds a computer too, not only the laptop button.
    await evaluate(`document.querySelector('[data-settings-add-computer]').click()`);
    await waitFor(`!!document.querySelector('dialog[data-add-computer]')?.open`);
    await screenshot("devices-add-computer");
    await evaluate(`document.querySelector('dialog[data-add-computer]').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.querySelector('dialog')`);
    await evaluate(`document.querySelector('[aria-label="Settings navigation"] button[aria-label="Back"]').click()`);
    await waitFor(`!!document.querySelector('[data-computers-button]') && !document.querySelector('.startup-splash-screen')`);
    console.log("PASS: a computer's gear opens its settings, with Show in sidebar; This Mac's opens Settings › Devices, which adds a computer");

    const scopes = () => evaluate(`[...document.querySelectorAll('[data-sidebar-scope]')].map((section) => section.dataset.sidebarScope)`);
    // Scope keys hold "|" and "/", which a double-quoted attribute selector takes as they are.
    const inScope = (scope, rest) => `[data-sidebar-scope="${scope}"] ${rest}`;
    const computerLines = (scope) =>
      evaluate(`[...document.querySelectorAll(${JSON.stringify(inScope(scope, "[data-scope-computer]"))})].map((line) => line.textContent.trim())`);
    await waitFor(`document.querySelectorAll('[data-sidebar-scope]').length === 4`);
    assert.deepEqual(
      await scopes(),
      ["c-atlas|/Users/a/atlas-web", "c-studio|/Users/s/homelab", "/work/milagre-ade", "c-studio|/Users/s/notes"],
      "one list, by Project name",
    );
    await waitFor(`document.querySelectorAll('[data-scope-computer]').length >= 3`);
    // Grouped, the computer sits in the Project's header, not on its rows.
    assert.equal(await evaluate(`document.querySelectorAll('[data-sidebar-scope] [data-chat-computer]').length`), 0);
    assert.deepEqual(await computerLines("/work/milagre-ade"), ["victor"], "a hostname shows its first part");
    assert.deepEqual(await computerLines("c-atlas|/Users/a/atlas-web"), ["atlas"]);
    assert.deepEqual(await computerLines("c-studio|/Users/s/homelab"), ["studio"]);
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(inScope("c-studio|/Users/s/homelab", "[data-scope-computer]"))}).hasAttribute('data-offline')`),
      true,
    );
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(inScope("c-studio|/Users/s/homelab", "[data-scope-toggle]"))}).getAttribute('aria-label')`),
      "Collapse homelab on studio, offline",
      "the header names its full computer for screen readers",
    );
    assert.equal(
      await evaluate(`document.querySelector('[data-sidebar-scope="c-studio|/Users/s/homelab"]').hasAttribute('data-offline')`),
      true,
      "the offline computer's Project is dimmed",
    );
    assert.equal(await evaluate(`document.querySelector('[data-sidebar-scope="c-atlas|/Users/a/atlas-web"]').hasAttribute('data-offline')`), false);
    // Dimmed once: the section is at 0.5 and its row adds no opacity of its own.
    assert.deepEqual(
      await evaluate(
        `(() => { const section = document.querySelector('[data-sidebar-scope="c-studio|/Users/s/homelab"]'); return [getComputedStyle(section).opacity, getComputedStyle(section.querySelector('[data-chat-id]')).opacity]; })()`,
      ),
      ["0.5", "1"],
      "an offline row is dimmed once",
    );
    await screenshot("merged-list");
    console.log("PASS: every computer's Projects in one list by name, each row naming its computer, the offline one dimmed");

    // At the sidebar's narrowest, a long computer name shows its first word, and a long Project name truncates while
    // the chip keeps its width, hovered too; the chip's tooltip has the full name.
    const atlas = "c-atlas|/Users/a/atlas-web";
    await evaluate(`window.setComputers(window.computerList.map((c) => c.id === 'c-atlas' ? { ...c, name: "Atlas’s Mac mini" } : c))`);
    await waitFor(`document.querySelector(${JSON.stringify(inScope(atlas, "[data-scope-computer]"))})?.textContent.trim() === 'Atlas'`);
    await evaluate(`document.querySelector(${JSON.stringify(inScope(atlas, "[data-scope-name]"))}).textContent = 'rd-events-admin-dashboard-and-docs'`);
    const headerFit = () =>
      evaluate(`(() => {
        const header = document.querySelector(${JSON.stringify(inScope(atlas, "[data-scope-toggle]"))});
        const name = header.querySelector('[data-scope-name]');
        const chip = header.querySelector('[data-scope-computer]');
        const alias = chip.lastElementChild;
        return { nameCut: name.scrollWidth > name.clientWidth, aliasWhole: alias.scrollWidth <= alias.clientWidth, gap: Math.round(header.getBoundingClientRect().right - chip.getBoundingClientRect().right) };
      })()`);
    assert.deepEqual(await headerFit(), { nameCut: true, aliasWhole: true, gap: 8 }, "the Project name gives way, not the chip, which sits at the right edge");
    await hover(inScope(atlas, "[data-scope-name]"));
    await waitFor(
      `!!document.querySelector(${JSON.stringify(inScope(atlas, "[data-scope-menu]"))}) && getComputedStyle(document.querySelector(${JSON.stringify(inScope(atlas, "[data-scope-menu]"))})).opacity === '1'`,
    );
    assert.deepEqual(await headerFit(), { nameCut: true, aliasWhole: true, gap: 60 }, "hovered, the chip moves left of the actions");
    await hover(inScope(atlas, "[data-scope-computer]"));
    await waitFor(`document.querySelector('[role="tooltip"]')?.textContent === 'Atlas’s Mac mini'`);
    await screenshot("long-names");
    await evaluate(`document.querySelector(${JSON.stringify(inScope(atlas, "[data-scope-name]"))}).textContent = 'atlas-web'`);
    await evaluate(`window.setComputers(window.computerList.map((c) => c.id === 'c-atlas' ? { ...c, name: "atlas" } : c))`);
    window.webContents.sendInputEvent({ type: "mouseMove", x: 900, y: 400 });
    await waitFor(`!document.querySelector('[role="tooltip"]')`);
    // The open Project's + shows only on hover too, so at rest its chip also reaches the edge.
    const current = "/work/milagre-ade";
    await waitFor(`getComputedStyle(document.querySelector(${JSON.stringify(inScope(current, "[data-scope-action]"))})).opacity === '0'`);
    assert.equal(
      await evaluate(
        `Math.round(document.querySelector(${JSON.stringify(inScope(current, "[data-scope-toggle]"))}).getBoundingClientRect().right - document.querySelector(${JSON.stringify(inScope(current, "[data-scope-computer]"))}).getBoundingClientRect().right)`,
      ),
      8,
    );
    console.log(
      "PASS: at the narrowest sidebar, a long Project name truncates before the computer chip, hovered too, and the chip's tooltip names the computer",
    );

    // Filters › Projects lists every computer's Projects under its computer (This Mac first, then by name), hidden ones unchecked.
    const choices = () =>
      evaluate(
        `[...document.querySelectorAll('[data-filters-sub="projects"] [data-project-choice]')].map((row) => [row.closest('[data-project-section]').dataset.projectSection, row.dataset.projectChoice, row.getAttribute('aria-checked')])`,
      );
    const sectionHeaders = () =>
      evaluate(`[...document.querySelectorAll('[data-filters-sub="projects"] [data-project-section-header]')].map((header) => header.textContent.trim())`);
    await evaluate(`document.querySelector('[data-filters]').click()`);
    await waitFor(`!!document.querySelector('[data-filters-panel] [data-sub="projects"]')`);
    await evaluate(`document.querySelector('[data-filters-panel] [data-sub="projects"]').click()`);
    await waitFor(`!!document.querySelector('[data-filters-sub="projects"]')`);
    assert.deepEqual(
      await choices(),
      [
        ["local", "/work/milagre-ade", "true"],
        ["c-atlas", "c-atlas|/Users/a/atlas-web", "true"],
        ["c-atlas", "c-atlas|/Users/a/old-site", "false"],
        ["c-studio", "c-studio|/Users/s/homelab", "true"],
        ["c-studio", "c-studio|/Users/s/notes", "true"],
      ],
      "every computer's Projects under its computer, by name, the hidden one unchecked",
    );
    assert.deepEqual(await sectionHeaders(), [`victor-mbp · ${ThisComputer}`, "atlas", "studio"]);
    assert.equal(await evaluate(`document.querySelector('[data-project-choice="/work/milagre-ade"]').textContent.includes('Open')`), true);
    await screenshot("filters-projects");
    await evaluate(`document.querySelector('[data-project-choice="c-atlas|/Users/a/old-site"]').click()`);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="c-atlas|/Users/a/old-site"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-project-choice="c-atlas|/Users/a/old-site"]').getAttribute('aria-checked')`), "true");
    await evaluate(`document.querySelector('[data-project-choice="c-atlas|/Users/a/old-site"]').click()`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="c-atlas|/Users/a/old-site"]')`);
    assert.deepEqual(
      await evaluate(`JSON.parse(localStorage.getItem("milagre.hiddenRemoteScopes") || "[]")`),
      ["c-atlas|/Users/a/old-site"],
      "the choice is saved on this Mac without mutating the other computer",
    );
    assert.equal(await evaluate(`window.remoteHiddenCalls`), 0, "the remote computer's setProjectHidden is never called");

    // A computer added while the menu is open brings its Projects in.
    await evaluate(
      `window.setComputers([...window.computerList, { id: "c-new", name: "garden-mini", hostId: "n".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: 3, message: null, lan: true, lanRoutes: [] }])`,
    );
    await waitFor(`!!document.querySelector('[data-project-choice="c-new|/Users/n/garden"]')`);
    assert.deepEqual(await sectionHeaders(), [`victor-mbp · ${ThisComputer}`, "atlas", "garden-mini", "studio"], "a new computer's section joins by name");
    await waitFor(`!!document.querySelector('[data-sidebar-scope="c-new|/Users/n/garden"]')`);
    await screenshot("filters-new-computer");
    await evaluate(`window.setComputers(window.computerList.filter((computer) => computer.id !== "c-new"))`);
    await waitFor(`!document.querySelector('[data-project-choice="c-new|/Users/n/garden"]')`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('[data-filters-panel]')`);
    console.log(
      "PASS: Filters › Projects lists every computer's Projects under its computer, hidden ones too, saves a choice on its computer, and follows a computer being added",
    );

    // Unchecking a computer in the popover leaves its Projects out of the sidebar; it stays listed, paired and connected.
    await openPopover();
    const studioShow = `document.querySelector('[data-computer-row="c-studio"] [data-computer-show]')`;
    assert.equal(await evaluate(`${studioShow}.getAttribute('aria-checked')`), "true");
    await evaluate(`${studioShow}.click()`);
    await waitFor(`!document.querySelector('[data-sidebar-scope^="c-studio|"]')`);
    assert.equal(await evaluate(`${studioShow}.getAttribute('aria-checked')`), "false");
    assert.equal(await evaluate(`!!document.querySelector('[data-computers-panel]')`), true, "the popover stays open");
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem("milagre.hiddenComputers") || "[]")`), ["c-studio"]);
    assert.deepEqual(await scopes(), ["c-atlas|/Users/a/atlas-web", "/work/milagre-ade"]);
    await screenshot("popover-hidden-computer");
    await evaluate(`document.querySelector('[data-computers-panel]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('[data-computers-panel]')`);
    // Filters › Projects leaves its Projects out too; the count is still the unchecked Projects listed.
    await evaluate(`document.querySelector('[data-filters]').click()`);
    await waitFor(`!!document.querySelector('[data-filters-panel] [data-sub="projects"]')`);
    assert.match(await evaluate(`document.querySelector('[data-filters-panel] [data-sub="projects"]').textContent`), /1 hidden/);
    await evaluate(`document.querySelector('[data-filters-panel] [data-sub="projects"]').click()`);
    await waitFor(`!!document.querySelector('[data-filters-sub="projects"]')`);
    assert.deepEqual(await sectionHeaders(), [`victor-mbp · ${ThisComputer}`, "atlas"], "no section for the hidden computer");
    assert.deepEqual(
      await choices(),
      [
        ["local", "/work/milagre-ade", "true"],
        ["c-atlas", "c-atlas|/Users/a/atlas-web", "true"],
        ["c-atlas", "c-atlas|/Users/a/old-site", "false"],
      ],
      "the hidden computer's Projects aren't listed",
    );
    await screenshot("filters-hidden-computer");
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('[data-filters-panel]')`);
    // A restart keeps it hidden; checking it again brings its Projects back.
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-computers-button]') && !document.querySelector('.startup-splash-screen')`);
    await waitFor(`document.querySelectorAll('[data-sidebar-scope]').length === 2`);
    await delay(150);
    assert.deepEqual(await scopes(), ["c-atlas|/Users/a/atlas-web", "/work/milagre-ade"], "still hidden after a restart");
    await openPopover();
    assert.equal(await evaluate(`${studioShow}.getAttribute('aria-checked')`), "false");
    await evaluate(`${studioShow}.click()`);
    await waitFor(`document.querySelectorAll('[data-sidebar-scope^="c-studio|"]').length === 2`);
    assert.equal(await evaluate(`localStorage.getItem("milagre.hiddenComputers")`), null);
    await evaluate(`document.querySelector('[data-computers-panel]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('[data-computers-panel]')`);
    assert.deepEqual(errors, []);
    console.log("PASS: unchecking a computer in the popover hides its Projects from the sidebar and Filters › Projects, and a restart keeps it");

    // Removing a computer's Project from the list asks that computer, and leaves this Mac's list as it was.
    await evaluate(`document.querySelector('[data-sidebar-scope="c-atlas|/Users/a/atlas-web"] [data-scope-menu]').click()`);
    await waitFor(`!!document.querySelector('[data-scope-menu-panel]')`);
    await evaluate(`document.querySelector('[data-scope-menu-item="remove"]').click()`);
    await waitFor(`!!document.querySelector('[data-project-remove-confirm]')`);
    await evaluate(`document.querySelector('[data-project-remove-confirm]').click()`);
    await waitFor(`(window.forgotten ?? []).includes('c-atlas|/Users/a/atlas-web')`);
    await waitFor(`!document.querySelector('[data-scope-menu-panel]')`);
    assert.ok((await scopes()).includes("/work/milagre-ade"), "this Mac's Project is still listed");
    assert.equal(await evaluate(`document.querySelectorAll('[data-sidebar-scope="/work/milagre-ade"] [data-chat-id]').length`), 1, "and keeps its chat");
    console.log("PASS: removing a computer's Project from the list leaves this Mac's list alone");

    const rowsBeforeComputerSwitch = await evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope] [data-chat-id]')].map((row) => row.closest('[data-sidebar-scope]').dataset.sidebarScope + '#' + row.dataset.chatId)`,
    );
    await evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope="c-atlas|/Users/a/atlas-web"] [data-chat-id] button')].find((b) => b.textContent.includes('Fix flaky deploy check')).click()`,
    );
    await waitFor(`document.querySelector('[data-chat-pane]')?.textContent.includes('The deploy check fails about one run in five.')`);
    assert.deepEqual(
      await evaluate(
        `[...document.querySelectorAll('[data-sidebar-scope] [data-chat-id]')].map((row) => row.closest('[data-sidebar-scope]').dataset.sidebarScope + '#' + row.dataset.chatId)`,
      ),
      rowsBeforeComputerSwitch,
      "switching to another computer's Chat preserves every sidebar row and its position",
    );
    // The window holds the Project's numbered state from the sidebar's read: the other Mac is only asked for its name and
    // number (project:read without the state), never project:switch, which would reorder its recent list and change its
    // open Project.
    await waitFor(
      `window.remoteCalls.some(([method, key, options]) => method === 'readProject' && key === 'c-atlas|/Users/a/atlas-web' && options?.state === false)`,
    );
    assert.equal(
      await evaluate(`window.remoteCalls.some(([method]) => method === 'switchProject')`),
      false,
      "another computer's Project opens without project:switch",
    );
    await waitFor(`document.querySelector('.sidebar-usage-row')?.textContent.includes('37%')`);
    assert.ok(
      await evaluate(`window.usageReads.some(([id, scope]) => id === 'c-atlas' && scope === 'c-atlas|/Users/a/atlas-web')`),
      "usage is read from the open Chat's computer and Project",
    );
    await evaluate(`document.querySelector('.sidebar-usage-row').click()`);
    await waitFor(`document.querySelector('[data-usage-account]')?.textContent.includes('remote@example.test')`);
    assert.equal(
      await evaluate(`!!document.querySelector('[data-usage-card] [aria-haspopup="listbox"]')`),
      false,
      "Usage keeps the account text when this computer supplies no account choices",
    );
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('[data-usage-card]')`);
    await screenshot("remote-chat");

    const menuOf = async (scope, title) => {
      await evaluate(
        `(() => { const button = [...document.querySelectorAll(${JSON.stringify(inScope(scope, "[data-chat-id] button"))})].find((b) => b.textContent.includes(${JSON.stringify(title)})); const r = button.getBoundingClientRect(); button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 10 })); })()`,
      );
      await waitFor(`!!document.querySelector('[role="menu"]')`);
      const labels = await evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent.trim())`);
      await evaluate(
        `(document.activeElement?.closest('[role="menu"]') ?? document.querySelector('[role="menu"]')).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      );
      await waitFor(`!document.querySelector('[role="menu"]')`);
      return labels;
    };
    const remoteMenu = await menuOf("c-atlas|/Users/a/atlas-web", "Fix flaky deploy check");
    assert.equal(
      remoteMenu.some((label) => /Finder|editor|Open in/.test(label)),
      false,
      `no local-only entry on a remote chat: ${remoteMenu}`,
    );
    assert.ok(remoteMenu.includes("Commit and open PR…"), "git works on the other Mac");
    const otherRemoteMenu = await menuOf("c-studio|/Users/s/homelab", "Backup rotation");
    assert.equal(
      otherRemoteMenu.some((label) => /Finder|editor|Open in/.test(label)),
      false,
      `no local-only entry on a remote chat that is not the open one: ${otherRemoteMenu}`,
    );
    const localMenu = await menuOf("/work/milagre-ade", "Desktop connect sidebar");
    assert.ok(
      localMenu.some((label) => /Finder|file manager/.test(label)),
      "this Mac's chats keep them",
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers: ["meta"] });
    await waitFor(`!!document.querySelector('dialog[open][aria-label="Command palette"]')`);
    const commands = await evaluate(`[...document.querySelectorAll('dialog[open] [role="option"]')].map((option) => option.textContent.trim())`);
    assert.equal(
      commands.some((label) => /Reveal folder|Open in editor/.test(label)),
      false,
      `no local-only command for a remote chat: ${commands}`,
    );
    await evaluate(`document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.querySelector('dialog[open]')`);
    console.log("PASS: a remote chat's menus and commands leave out Finder and the editor; this Mac's keep them");
    console.log("PASS: a remote computer's chat opens from the merged list");

    await evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/homelab"] [data-chat-id] button')].find((b) => b.textContent.includes('Backup rotation')).click()`,
    );
    await waitFor(`!!document.querySelector('[data-offline-chip]')`);
    assert.equal(await evaluate(`document.querySelector('[data-offline-chip]').textContent.trim()`), "studiooffline");
    assert.equal(await evaluate(`!!document.querySelector('[data-offline-composer] [data-offline-tray]')`), true, "the chip sits in the composer's tray");
    assert.equal(await evaluate(`document.querySelector('[data-prompt-editor]').getAttribute('aria-disabled')`), null);
    assert.equal(await evaluate(`document.querySelector('[data-prompt-editor]').getAttribute('aria-placeholder')`), "Queue a message for studio…");
    assert.equal(await evaluate(`!!document.querySelector('[data-offline-empty]')`), false, "a cached chat shows its copy");
    assert.ok(await evaluate(`document.querySelector('[data-chat-pane]').textContent.includes('Rotate the nightly backups.')`));
    await screenshot("offline-chat");
    console.log("PASS: an offline computer's chat shows the last copy, with the composer in a tray naming the computer offline");

    await evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/notes"] [data-chat-id] button')].find((b) => b.textContent.includes('Never opened here')).click()`,
    );
    await waitFor(`!!document.querySelector('[data-offline-empty]')`);
    assert.equal(await evaluate(`document.querySelector('[data-offline-empty]').textContent.trim()`), `No copy of this chat on ${thisComputer} yet.`);
    // A host that keeps messages by Chat: the Chat's page read goes out first, then the Project's read, so it isn't queued
    // behind everything the switch's render asks the other Mac for.
    const notesCalls = await evaluate(
      `window.remoteCalls.filter(([, key]) => key === 'c-studio|/Users/s/notes').map(([method, , detail]) => method + (detail?.state === false ? ' header' : ''))`,
    );
    assert.ok(
      notesCalls.includes("readChatMessages") && notesCalls.indexOf("readChatMessages") < notesCalls.indexOf("readProject header"),
      `the page read leads the open: ${notesCalls}`,
    );
    await screenshot("offline-chat-empty");
    await evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/homelab"] [data-chat-id] button')].find((b) => b.textContent.includes('Backup rotation')).click()`,
    );
    await waitFor(`document.querySelector('[data-chat-pane]').textContent.includes('Rotate the nightly backups.')`);

    await evaluate(
      `(() => { const box = document.querySelector('[data-prompt-editor]'); box.value = "Queued while studio sleeps"; box.dispatchEvent(new Event("input", { bubbles: true })); box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`,
    );
    await waitFor(`!!document.querySelector('[data-offline-tray] [data-outbox-state="queued"]')`);
    // The clock says it waits; the row shows only the message.
    assert.equal(await evaluate(`document.querySelector('[data-offline-message]').textContent`), "Queued while studio sleeps");
    await waitFor(`[...document.querySelectorAll('[data-chat-waiting]')].some((node) => node.textContent === "1 waiting")`);
    assert.equal(await evaluate(`window.sent.length`), 0, "offline enqueue never sends to the host");
    assert.equal(await evaluate(`document.querySelector('[data-prompt-editor]').value`), "", "the composer clears after the durable write");
    await screenshot("offline-queued");
    await new Promise((resolve) => {
      window.webContents.once("did-finish-load", resolve);
      window.webContents.reload();
    });
    await waitFor(
      `!document.querySelector('.startup-splash-screen') && [...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/homelab"] [data-chat-id] button')].some((b) => b.textContent.includes('Backup rotation'))`,
      20000,
    );
    // The sidebar row still says what waits for studio after a restart.
    await waitFor(`[...document.querySelectorAll('[data-chat-waiting]')].some((node) => node.textContent === "1 waiting")`);
    await evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/homelab"] [data-chat-id] button')].find((b) => b.textContent.includes('Backup rotation')).click()`,
    );
    await waitFor(
      `!!document.querySelector('[data-offline-chip]') && document.querySelector('[data-offline-tray]')?.textContent.includes('Queued while studio sleeps')`,
    );
    assert.equal(await evaluate(`window.sent.length`), 0, "restarting while offline keeps the message local, in its Chat");
    await screenshot("offline-queued-after-restart");
    // The computer comes back: the chip goes, the message goes out and leaves the tray, and sending works, to that computer.
    await evaluate(
      `window.setComputers(window.computerList.map((c) => c.id === 'c-studio' ? { ...c, state: 'online', route: 'relay', lastSeen: Date.now() } : c))`,
    );
    await waitFor(`!document.querySelector('[data-offline-chip]') && !document.querySelector('[data-prompt-editor]').hasAttribute('aria-disabled')`);
    await waitFor(`window.sent.length === 1 && !document.querySelector('[data-outbox-state]') && !document.querySelector('[data-offline-composer]')`);
    assert.equal(await evaluate(`window.sent[0].body`), "Queued while studio sleeps");
    await evaluate(
      `(() => { const box = document.querySelector('[data-prompt-editor]'); box.value = "Keep 8 dailies"; box.dispatchEvent(new Event("input", { bubbles: true })); box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`,
    );
    await waitFor(`window.sent.length === 2`);
    assert.equal(await evaluate(`window.sent[0].projectPath`), "c-studio|/Users/s/homelab", "the send goes to studio's bridge, with the key main strips");
    console.log("PASS: back online, the composer sends to that computer");

    // Removing the computer whose chat is open brings this Mac's Project back.
    await evaluate(`window.setComputers(window.computerList.filter((c) => c.id !== 'c-studio'))`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="c-studio|/Users/s/homelab"]') && !document.querySelector('[data-offline-chip]')`);
    await waitFor(`document.querySelector('[data-sidebar-scope][data-current]')?.dataset.sidebarScope === '/work/milagre-ade'`);
    console.log("PASS: removing the open chat's computer goes back to this Mac's Project");

    // The same repository cloned on atlas: one heading for both copies, their chats in one list, each naming its computer.
    const shared = "github.com/the-ptf/milagre-ade";
    await evaluate(`(() => {
      const state = structuredClone(window.remoteProjects["c-atlas-hidden"].state);
      state.sessions[4].title = "Clone on atlas";
      window.remoteProjects["c-atlas-clone"] = { path: "c-atlas|/Users/a/milagre-ade", name: "milagre-ade", origin: ${JSON.stringify(shared)}, state };
      window.setLocalOrigin(${JSON.stringify(shared)});
      window.dispatchEvent(new Event("milagre:recent-projects-changed"));
    })()`);
    const localScope = "/work/milagre-ade";
    await waitFor(`document.querySelector('[data-sidebar-scope="${localScope}"]')?.dataset.sidebarCopies === "${localScope}\\nc-atlas|/Users/a/milagre-ade"`);
    assert.equal(
      await evaluate(`!!document.querySelector('[data-sidebar-scope="c-atlas|/Users/a/milagre-ade"]')`),
      false,
      "the clone has no heading of its own",
    );
    assert.equal(
      await evaluate(`document.querySelectorAll(${JSON.stringify(inScope(localScope, "[data-scope-computer]"))}).length`),
      0,
      "the shared heading names no computer",
    );
    await waitFor(`document.querySelectorAll(${JSON.stringify(inScope(localScope, "[data-chat-id]"))}).length === 2`);
    assert.deepEqual(
      await evaluate(
        `[...document.querySelectorAll(${JSON.stringify(inScope(localScope, "[data-chat-id]"))})].map((row) => [row.querySelector('[data-row]')?.textContent.includes('Clone on atlas') ? 'clone' : 'local', row.querySelector('[data-chat-computer]')?.textContent.trim()]).sort()`,
      ),
      [
        ["clone", "atlas"],
        ["local", "victor-mbp"],
      ],
      "each row names its computer",
    );
    await screenshot("shared-project");
    await evaluate(`(() => {
      delete window.remoteProjects["c-atlas-clone"];
      window.setLocalOrigin(null);
      window.dispatchEvent(new Event("milagre:recent-projects-changed"));
    })()`);
    await waitFor(`!document.querySelector('[data-sidebar-copies]') && !!document.querySelector('[data-sidebar-scope="${localScope}"]')`);
    assert.deepEqual(errors, []);
    console.log("PASS: one repository on two computers is one heading, and each of its rows names its computer");

    await evaluate(`window.setOther(false)`);
    await waitFor(`!document.querySelector('[data-chat-computer], [data-scope-computer]')`);
    await waitFor(`!document.querySelector('[data-computers-button]')`);
    await evaluate(`window.setOther(true)`);
    await waitFor(`!!document.querySelector('[data-computers-button]') && !document.querySelector('.startup-splash-screen')`);
    console.log("PASS: with only this Mac, rows have no computer line");
    await openPopover();
    await evaluate(`document.querySelector('[data-add-computer-row]').click()`);
    await waitFor(`document.querySelector('dialog[data-add-computer]')?.open && !document.querySelector('[data-computers-panel]')`);
    await evaluate(`document.querySelector('dialog[data-add-computer]').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.querySelector('dialog')`);
    await evaluate(`window.setOther(false)`);
    await waitFor(`!document.querySelector('[data-computers-button]')`);
    assert.deepEqual(errors, []);
    console.log("PASS: Add computer opens from the popover, and nothing about computers shows while Other computers is off");

    // A slow initial remote read must not undo live pin settings received while it was in flight.
    await window.loadURL(process.argv[2] + "?race=1");
    await waitFor(`typeof window.finishRemoteRead === 'function'`);
    await evaluate(`window.pushRemote({ ...window.remoteProjects['c-atlas'].state, messages: [], messagesInChats: true, sessions: {
      4: { id: 4, worktree_id: 1, agent_name: 'Claude', status: 'Idle', pinned: true, pin_order: 1, summary: { count: 5, firstId: 1, lastId: 20, titleLine: 'Fix flaky deploy check' } },
      8: { id: 8, worktree_id: 1, agent_name: 'Claude', status: 'Idle', pinned: true, pin_order: 0, summary: { count: 2, firstId: 9, lastId: 12, titleLine: 'Newer remote chat' } }
    } })`);
    const remoteIds = `[...document.querySelectorAll('[data-pinned-scope="c-atlas|/Users/a/atlas-web"] [data-chat-id], [data-sidebar-scope="c-atlas|/Users/a/atlas-web"] [data-chat-id]')].map(row => row.dataset.chatId)`;
    await waitFor(`JSON.stringify(${remoteIds}) === '["8","4"]'`);
    await evaluate(`window.finishRemoteRead()`);
    await delay(150);
    assert.deepEqual(await evaluate(remoteIds), ["8", "4"], "the delayed snapshot keeps the live pin order");
    await evaluate(`(() => {
      const state = structuredClone(window.remoteProjects['c-atlas'].state);
      for (const chat of Object.values(state.sessions)) chat.pinned = false;
      window.pushRemote(state);
      window.setChatOrder('recent');
    })()`);
    await waitFor(`JSON.stringify(${remoteIds}) === '["4","8"]'`);
    await evaluate(`window.setChatOrder('created')`);
    await waitFor(`JSON.stringify(${remoteIds}) === '["8","4"]'`);
    await screenshot("remote-chat-order");
    // Removing the last local Project preserves access to the other computer from the full App.
    await evaluate(`document.querySelector('[data-sidebar-scope="/work/milagre-ade"] [data-scope-menu]').click()`);
    await waitFor(`!!document.querySelector('[data-scope-menu-item="remove"]')`);
    await evaluate(`document.querySelector('[data-scope-menu-item="remove"]').click()`);
    await waitFor(`!!document.querySelector('[data-project-remove-confirm]')`);
    await evaluate(`document.querySelector('[data-project-remove-confirm]').click()`);
    await waitFor(`!!document.querySelector('[data-project-chooser]')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-onboarding]')`), false);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="c-atlas|/Users/a/atlas-web"] [data-scope-action]')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-sidebar-scope="/work/milagre-ade"]')`), false);
    await screenshot("last-local-project-removed");
    await evaluate(`document.querySelector('[data-sidebar-scope="c-atlas|/Users/a/atlas-web"] [data-scope-action]').click()`);
    await waitFor(`document.querySelector('[data-sidebar-scope][data-current]')?.dataset.sidebarScope === 'c-atlas|/Users/a/atlas-web'`);
    assert.equal(await evaluate(`!!document.querySelector('[data-project-chooser]')`), false);
    console.log("PASS: removing the last local Project keeps remote Projects accessible and opens one from the chooser");
    assert.deepEqual(errors, []);
    console.log("PASS: remote chats retain live pin settings through a delayed read and follow both Chat order choices");
    // A host enabled outside this window overrides stale local preferences without a disconnect on launch.
    await window.loadURL(process.argv[2] + "?daemon=1");
    await waitFor(`!!document.querySelector('[data-computers-button]') && document.querySelectorAll('[data-sidebar-scope]').length === 4`);
    assert.deepEqual(await evaluate(`window.computerEnableCalls`), [], "opening a window never overwrites the daemon's saved choice");
    await evaluate(`window.setChatList('list')`);
    await waitFor(`!!document.querySelector('[data-chat-list-flat] [data-chat-computer]')`);
    const rowNames = await evaluate(`[...document.querySelectorAll('[data-chat-list-flat] [data-chat-computer]')].map(node => node.textContent.trim())`);
    assert.ok(rowNames.includes("victor-mbp"), "the local Mac is tagged in One list too");
    assert.ok(rowNames.includes("atlas"), "the online remote computer is tagged");
    await screenshot("one-list-computer-tags");
    await evaluate(`window.setDaemonEnabled(false)`);
    await waitFor(`!document.querySelector('[data-computers-button]')`);
    await evaluate(`window.setDaemonEnabled(true)`);
    await waitFor(`!!document.querySelector('[data-computers-button]')`);
    assert.deepEqual(await evaluate(`window.computerEnableCalls`), [], "external changes reach the UI without writing them back");
    await evaluate(`window.setOther(false)`);
    await waitFor(`window.computerEnableCalls.includes(false)`);
    await evaluate(`window.setOther(true)`);
    await waitFor(`window.computerEnableCalls.at(-1) === true`);
    console.log("PASS: daemon settings restore and update the window; every computer has a tag in One list");
    assert.deepEqual(errors, []);
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    console.error(
      "Fixture state:",
      await evaluate(
        `({ ready: document.readyState, buttons: [...document.querySelectorAll("[data-computers-button]")].length, splash: document.querySelector(".startup-splash-screen")?.outerHTML, body: document.body.innerText.slice(0, 1600) })`,
      ),
    );
    await screenshot("failure").catch(() => {});
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-sidebar-computers"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "sidebar-computers-fixture",
        resolveId(id) {
          if (id === "/__sidebar-computers.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar-computers.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url.split("?")[0] !== "/__sidebar-computers") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__sidebar-computers.tsx"></script></body></html>',
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
    // Keep the real splash and panel animations painting when another macOS window covers this check.
    const unthrottled = ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"];
    const child = require("node:child_process").spawn(
      require("electron"),
      [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar-computers`, ...unthrottled],
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
