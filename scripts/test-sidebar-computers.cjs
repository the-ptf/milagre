// Run with npm test -- --only test-sidebar-computers. The footer's computers popover in the real App against a stand-in for
// main: the laptop button opens a popover of This Mac and each computer with its route line, a gear with its tooltip
// opens that computer's settings (This Mac's opens Settings › Devices), Add computer opens its dialog, and nothing about
// computers shows while Settings › Experimental › Other computers is off. Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
// This fixture exercises a device that has already accepted AI sharing.
import { AI_CONSENT_VERSION } from "@milagre/shared/ai-consent";
localStorage.setItem("milagre.ai-sharing-consent", AI_CONSENT_VERSION);
import React from "react";
import { createRoot } from "react-dom/client";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const HOUR = 3600000;
const local = { next_id: 3, projects: { 1: { id: 1, name: "milagre-ade" } }, worktrees: { 1: { id: 1, name: "main", path: "/work/milagre-ade", project_id: 1 } }, sessions: { 2: { id: 2, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title: "Desktop connect sidebar" } }, connections: {}, events: [], messages: [{ id: 2, session_id: 2, role: "user", body: "Connect the sidebar" }], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
window.computerList = [
  { id: "c-arketa", name: "arketa", hostId: "a".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: 1, message: null, lan: true, lanRoutes: ["ws://192.168.0.24:8798"] },
  { id: "c-studio", name: "studio", hostId: "s".repeat(22), relayHost: "relay.milagre.cloud", state: "offline", route: null, lastSeen: Date.now() - 2 * HOUR, addedAt: 1, message: null, lan: false, lanRoutes: [] },
];
let computersChanged = () => {};
window.setComputers = (list) => { window.computerList = list; computersChanged({ thisMac: "victor-mbp", computers: list }); };
const remoteState = (title, body) => ({ next_id: 9, projects: { 1: { id: 1, name: "p" } }, worktrees: { 1: { id: 1, name: "main", path: "/remote", project_id: 1 } }, sessions: { 4: { id: 4, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title } }, connections: {}, events: [], messages: [{ id: 4, session_id: 4, role: "user", body }], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] });
const remoteProjects = {
  "c-arketa": { path: "c-arketa|/Users/a/arketa-web", name: "arketa-web", state: remoteState("Fix flaky deploy check", "The deploy check fails about one run in five.") },
  "c-studio": { path: "c-studio|/Users/s/homelab", name: "homelab", state: remoteState("Backup rotation", "Rotate the nightly backups.") },
  // Hidden on its computer: not in the sidebar, but in the project chooser, unchecked.
  "c-arketa-hidden": { path: "c-arketa|/Users/a/old-site", name: "old-site", hidden: true, state: remoteState("Old site", "Retire it.") },
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
window.sent = [];
// Each computer's bridge, as main would answer it: keys already name the computer.
const projectsOf = (id) => Object.values(remoteProjects).filter((project) => project.path.startsWith(id + "|"));
const projectAt = async (key) => Object.values(remoteProjects).find((project) => project.path === key);
const remote = (id) => new Proxy({
  listRecentProjects: async () => projectsOf(id).map(({ path, name, hidden }) => ({ path, name, ...(hidden ? { hidden } : {}) })),
  setProjectHidden: async (key, hidden) => {
    Object.values(remoteProjects).find((project) => project.path === key).hidden = hidden;
    return projectsOf(id).map(({ path, name, hidden }) => ({ path, name, ...(hidden ? { hidden } : {}) }));
  },
  listNamedLinks: async () => [],
  readProject: projectAt,
  switchProject: projectAt,
  // As main's offline cache answers a chat it kept nothing of (Task 20).
  readChatMessages: async () => ({ messages: [], hasMore: false, total: 0 }),
  getRuns: async () => ({ runs: {}, seq: 0 }),
  listBranches: async () => ["main"],
  // A computer answers with its own list; this Mac's must not become it.
  forgetProject: async (key) => ((window.forgotten ??= []).push(key), projectsOf(id).filter((project) => project.path !== key).map(({ path, name }) => ({ path, name }))),
  sendMessage: async (request) => (window.sent.push(request), { sessionId: 4 }),
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
const remotes = { "c-arketa": remote("c-arketa"), "c-studio": remote("c-studio"), "c-new": remote("c-new") };
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getCurrentProject: async () => ({ path: "/work/milagre-ade", name: "milagre-ade", state: local }),
  listRecentProjects: async () => [{ path: "/work/milagre-ade", name: "milagre-ade" }],
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
  onComputersChanged: (callback) => ((computersChanged = callback), () => {}),
  computers: {
    list: async () => ({ thisMac: "victor-mbp", computers: window.computerList }),
    setEnabled: async () => {},
    invoke: async (id, method) => (method === "daemon:status" ? { version: "0.121.0" } : method === "project:recent" ? [] : null),
    preview: async () => { throw new Error("That isn't a Milagre pairing link. Copy it from Settings › Devices on the other Mac."); },
  },
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
// settings.ts read localStorage when it was imported above, so the saved settings go through its own setter.
updateSettings({ defaultModelId: "claude-opus-5-5", defaultPermissionMode: "ask", otherComputers: true });
window.setOther = (otherComputers) => updateSettings({ otherComputers });
const { default: App } = await import("/src/App");
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-sidebar-computers-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
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
    await waitFor(`!!document.querySelector('[data-computers-button]')`);
    await openPopover();
    assert.deepEqual(await lines(), [
      ["this-mac", "victor-mbp", "This Mac"],
      ["c-arketa", "arketa", "Same network"],
      ["c-studio", "studio", "Offline, seen 2h ago"],
    ]);
    assert.equal(await evaluate(`!!document.querySelector('[data-computers-panel] [data-add-computer-row]')`), true);
    await screenshot("popover");
    await hover('[data-computer-row="c-arketa"] [data-computer-gear]');
    await waitFor(`[...document.querySelectorAll('[role="tooltip"]')].some((tip) => tip.textContent.includes('arketa settings: rename, connection, remove'))`);
    await screenshot("popover-gear");
    console.log("PASS: the popover lists This Mac, then each computer with its route line, a gear with its tooltip, and Add computer");

    await evaluate(`document.querySelector('[data-computer-row="c-arketa"] [data-computer-gear]').click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'arketa' && !!document.querySelector('[data-computer-settings]')`);
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Back').click()`);
    await waitFor(`!!document.querySelector('[data-computers-button]')`);
    await openPopover();
    await evaluate(`document.querySelector('[data-computer-row="this-mac"] [data-computer-gear]').click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'Devices'`);
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Back').click()`);
    await waitFor(`!!document.querySelector('[data-computers-button]')`);
    console.log("PASS: a computer's gear opens its settings, and This Mac's opens Settings › Devices");

    const scopes = () => evaluate(`[...document.querySelectorAll('[data-sidebar-scope]')].map((section) => section.dataset.sidebarScope)`);
    // Scope keys hold "|" and "/", which a double-quoted attribute selector takes as they are.
    const inScope = (scope, rest) => `[data-sidebar-scope="${scope}"] ${rest}`;
    const computerLines = (scope) =>
      evaluate(`[...document.querySelectorAll(${JSON.stringify(inScope(scope, "[data-chat-computer]"))})].map((line) => line.textContent.trim())`);
    await waitFor(`document.querySelectorAll('[data-sidebar-scope]').length === 4`);
    assert.deepEqual(
      await scopes(),
      ["c-arketa|/Users/a/arketa-web", "c-studio|/Users/s/homelab", "/work/milagre-ade", "c-studio|/Users/s/notes"],
      "one list, by Project name",
    );
    await waitFor(`document.querySelectorAll('[data-chat-computer]').length >= 3`);
    assert.deepEqual(await computerLines("/work/milagre-ade"), ["victor-mbp"]);
    assert.deepEqual(await computerLines("c-arketa|/Users/a/arketa-web"), ["arketa"]);
    assert.deepEqual(await computerLines("c-studio|/Users/s/homelab"), ["studio, offline"]);
    assert.equal(
      await evaluate(`document.querySelector('[data-sidebar-scope="c-studio|/Users/s/homelab"]').hasAttribute('data-offline')`),
      true,
      "the offline computer's Project is dimmed",
    );
    assert.equal(await evaluate(`document.querySelector('[data-sidebar-scope="c-arketa|/Users/a/arketa-web"]').hasAttribute('data-offline')`), false);
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

    // Filters › Projects lists every computer's Projects, hidden ones unchecked, each naming its computer.
    const choices = () =>
      evaluate(
        `[...document.querySelectorAll('[data-filters-sub="projects"] [data-project-choice]')].map((row) => [row.dataset.projectChoice, row.getAttribute('aria-checked'), row.lastElementChild.textContent])`,
      );
    await evaluate(`document.querySelector('[data-filters]').click()`);
    await waitFor(`!!document.querySelector('[data-filters-panel] [data-sub="projects"]')`);
    await evaluate(`document.querySelector('[data-filters-panel] [data-sub="projects"]').click()`);
    await waitFor(`!!document.querySelector('[data-filters-sub="projects"]')`);
    assert.deepEqual(
      await choices(),
      [
        ["c-arketa|/Users/a/arketa-web", "true", "arketa"],
        ["c-studio|/Users/s/homelab", "true", "studio"],
        ["/work/milagre-ade", "true", "Open"],
        ["c-studio|/Users/s/notes", "true", "studio"],
        ["c-arketa|/Users/a/old-site", "false", "arketa"],
      ],
      "every computer's Projects by name, the hidden one unchecked",
    );
    await screenshot("filters-projects");
    await evaluate(`document.querySelector('[data-project-choice="c-arketa|/Users/a/old-site"]').click()`);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="c-arketa|/Users/a/old-site"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-project-choice="c-arketa|/Users/a/old-site"]').getAttribute('aria-checked')`), "true");
    await evaluate(`document.querySelector('[data-project-choice="c-arketa|/Users/a/old-site"]').click()`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="c-arketa|/Users/a/old-site"]')`);
    assert.equal(await evaluate(`window.remoteProjects["c-arketa-hidden"].hidden`), true, "the choice is saved on that computer");

    // A computer added while the menu is open brings its Projects in.
    await evaluate(
      `window.setComputers([...window.computerList, { id: "c-new", name: "garden-mini", hostId: "n".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: 3, message: null, lan: true, lanRoutes: [] }])`,
    );
    await waitFor(`!!document.querySelector('[data-project-choice="c-new|/Users/n/garden"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-project-choice="c-new|/Users/n/garden"]').lastElementChild.textContent`), "garden-mini");
    await waitFor(`!!document.querySelector('[data-sidebar-scope="c-new|/Users/n/garden"]')`);
    await screenshot("filters-new-computer");
    await evaluate(`window.setComputers(window.computerList.filter((computer) => computer.id !== "c-new"))`);
    await waitFor(`!document.querySelector('[data-project-choice="c-new|/Users/n/garden"]')`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('[data-filters-panel]')`);
    console.log(
      "PASS: Filters › Projects lists every computer's Projects, hidden ones too, saves a choice on its computer, and follows a computer being added",
    );

    // Removing a computer's Project from the list asks that computer, and leaves this Mac's list as it was.
    await evaluate(`document.querySelector('[data-sidebar-scope="c-arketa|/Users/a/arketa-web"] [data-scope-menu]').click()`);
    await waitFor(`!!document.querySelector('[data-scope-menu-panel]')`);
    await evaluate(
      `[...document.querySelectorAll('[data-scope-menu-panel] [role="menuitem"]')].find((item) => item.textContent.includes('Remove from list')).click()`,
    );
    await waitFor(`(window.forgotten ?? []).includes('c-arketa|/Users/a/arketa-web')`);
    await waitFor(`!document.querySelector('[data-scope-menu-panel]')`);
    assert.ok((await scopes()).includes("/work/milagre-ade"), "this Mac's Project is still listed");
    assert.equal(await evaluate(`document.querySelectorAll('[data-sidebar-scope="/work/milagre-ade"] [data-chat-id]').length`), 1, "and keeps its chat");
    console.log("PASS: removing a computer's Project from the list leaves this Mac's list alone");

    await evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope="c-arketa|/Users/a/arketa-web"] [data-chat-id] button')].find((b) => b.textContent.includes('Fix flaky deploy check')).click()`,
    );
    await waitFor(`document.querySelector('[data-chat-pane]')?.textContent.includes('The deploy check fails about one run in five.')`);
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
    const remoteMenu = await menuOf("c-arketa|/Users/a/arketa-web", "Fix flaky deploy check");
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
    await waitFor(`!!document.querySelector('[data-offline-banner]')`);
    assert.equal(
      await evaluate(`document.querySelector('[data-offline-banner]').textContent.trim()`),
      "studio is offline. This is the last copy it sent, 2h ago. You can read it until studio is back.",
    );
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').disabled`), true);
    assert.match(await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').placeholder`), / \(studio is offline\)$/);
    assert.equal(await evaluate(`!!document.querySelector('[data-offline-empty]')`), false, "a cached chat shows its copy");
    assert.ok(await evaluate(`document.querySelector('[data-chat-pane]').textContent.includes('Rotate the nightly backups.')`));
    await screenshot("offline-chat");
    console.log("PASS: an offline computer's chat shows the last copy under the banner, with the composer off");

    await evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/notes"] [data-chat-id] button')].find((b) => b.textContent.includes('Never opened here')).click()`,
    );
    await waitFor(`!!document.querySelector('[data-offline-empty]')`);
    assert.equal(await evaluate(`document.querySelector('[data-offline-empty]').textContent.trim()`), "No copy of this chat on this Mac yet.");
    await screenshot("offline-chat-empty");
    await evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/homelab"] [data-chat-id] button')].find((b) => b.textContent.includes('Backup rotation')).click()`,
    );
    await waitFor(`document.querySelector('[data-chat-pane]').textContent.includes('Rotate the nightly backups.')`);

    // The computer comes back: the banner goes and sending works, to that computer.
    await evaluate(
      `window.setComputers(window.computerList.map((c) => c.id === 'c-studio' ? { ...c, state: 'online', route: 'relay', lastSeen: Date.now() } : c))`,
    );
    await waitFor(`!document.querySelector('[data-offline-banner]') && !document.querySelector('textarea[aria-label="Prompt"]').disabled`);
    await evaluate(
      `(() => { const box = document.querySelector('textarea[aria-label="Prompt"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Keep 8 dailies"); box.dispatchEvent(new Event("input", { bubbles: true })); box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`,
    );
    await waitFor(`window.sent.length === 1`);
    assert.equal(await evaluate(`window.sent[0].projectPath`), "c-studio|/Users/s/homelab", "the send goes to studio's bridge, with the key main strips");
    console.log("PASS: back online, the composer sends to that computer");

    // Removing the computer whose chat is open brings this Mac's Project back.
    await evaluate(`window.setComputers(window.computerList.filter((c) => c.id !== 'c-studio'))`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="c-studio|/Users/s/homelab"]') && !document.querySelector('[data-offline-banner]')`);
    await waitFor(`document.querySelector('[data-sidebar-scope][data-current]')?.dataset.sidebarScope === '/work/milagre-ade'`);
    console.log("PASS: removing the open chat's computer goes back to this Mac's Project");

    await evaluate(`window.setOther(false)`);
    await waitFor(`!document.querySelector('[data-chat-computer]')`);
    await waitFor(`!document.querySelector('[data-computers-button]')`);
    await evaluate(`window.setOther(true)`);
    await waitFor(`!!document.querySelector('[data-computers-button]')`);
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
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__sidebar-computers") return next();
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar-computers`], {
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
