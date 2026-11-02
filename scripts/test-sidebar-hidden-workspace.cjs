// Run with npm test -- --only test-sidebar-hidden-workspace. The real App against a stand-in for main, with a Link and a
// Project both on another computer. The Link's and the Project's workspaces stay mounted behind each other (an
// <Activity>), so the hidden one's sidebar hears no events: the remote Project gains a Chat while one workspace is on
// screen, and switching to the other must list it there too, not the rows that sidebar froze with. Set
// MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const local = { next_id: 3, projects: { 1: { id: 1, name: "milagre-ade" } }, worktrees: { 1: { id: 1, name: "main", path: "/work/milagre-ade", project_id: 1 } }, sessions: { 2: { id: 2, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title: "Local chat" } }, connections: {}, events: [], messages: [{ id: 2, session_id: 2, role: "user", body: "Local" }], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
window.computerList = [
  { id: "c-atlas", name: "atlas", hostId: "a".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: 1, message: null, lan: true, lanRoutes: [] },
];
const computerEvents = new Set();
const session = (id, title) => ({ id, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title, summary: { count: 2, firstId: id * 10, lastId: id * 10 + 1, titleLine: title, lastAt: Date.now() - id * 1000, firstAt: Date.now() - id * 2000 } });
const remoteState = (ids) => ({ next_id: 20, projects: { 1: { id: 1, name: "p" } }, worktrees: { 1: { id: 1, name: "main", path: "/remote", project_id: 1 } }, sessions: Object.fromEntries(ids.map((id) => [id, session(id, "Remote chat " + id)])), connections: {}, events: [], messages: [], messagesInChats: true, approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] });
const KEY = "c-atlas|/Users/a/atlas-web";
// atlas's Project, numbered as a host that sends patches numbers it; pushRemote is a new Chat arriving as a patch.
window.scopeDelay = 0;
const waitLists = async (value) => { await new Promise(resolve => setTimeout(resolve, window.scopeDelay)); return value; };
window.remote = { state: remoteState([4]), version: 1 };
window.pushRemote = (ids) => {
  window.remote.state = remoteState(ids);
  window.remote.version++;
  for (const callback of computerEvents) callback({ channel: "project:state", payload: { path: KEY, patch: { v: window.remote.state }, base: window.remote.version - 1, version: window.remote.version, epoch: "fixture-host" } });
};
// A Link on atlas too, as main qualifies its id.
const LINK_ID = "c-atlas|11111111-2222-4333-8444-555555555555";
const link = { id: LINK_ID, name: "RD Food", projectIds: ["p1"], createdAt: "" };
const linkState = { next_id: 9, messagesInChats: true, sessions: { 3: { id: 3, agent_name: "Claude", provider: "claude", status: "Idle", title: "Link chat", workspacePath: "/w", worktrees: [], summary: { count: 1, firstId: 1, lastId: 1, titleLine: "Link chat" } } }, messages: [], preparations: {} };
const remoteBridge = new Proxy({
  listRecentProjects: async () => waitLists([{ path: KEY, name: "atlas-web" }]),
  listNamedLinks: async () => waitLists([link]),
  openNamedLink: async () => ({ link, projects: [{ id: "p1", path: KEY, name: "atlas-web" }], state: structuredClone(linkState), version: 1, epoch: "link-host" }),
  readLink: async () => ({ link, state: structuredClone(linkState), version: 1, epoch: "link-host" }),
  readProject: async (key, options) => (options?.state === false ? { path: KEY, name: "atlas-web", git: true, version: window.remote.version, epoch: "fixture-host" } : { path: KEY, name: "atlas-web", git: true, state: structuredClone(window.remote.state), version: window.remote.version, epoch: "fixture-host" }),
  readChatMessages: async () => ({ messages: [], hasMore: false, total: 0 }),
  getRuns: async () => ({ runs: {}, seq: 0 }),
  listBranches: async () => ["main"],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getCurrentProject: async () => ({ path: "/work/milagre-ade", name: "milagre-ade", state: local }),
  listRecentProjects: async () => [{ path: "/work/milagre-ade", name: "milagre-ade" }],
  readProject: async () => ({ path: "/work/milagre-ade", name: "milagre-ade", state: local }),
  switchProject: async () => ({ path: "/work/milagre-ade", name: "milagre-ade", state: local }),
  listProjects: async () => [{ id: "p1", path: "/work/milagre-ade", name: "milagre-ade" }],
  listNamedLinks: async () => [],
  readChatMessages: async () => ({ messages: [], hasMore: false, total: 0 }),
  listBranches: async () => ["main"],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: "idle" }),
  getAppVersion: async () => "0.0.0",
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getRuns: async () => ({ runs: {}, seq: 0 }),
  on: (id) => remoteBridge,
  getPhoneStatus: async () => ({ enabled: false, state: "off", remote: "none" }),
  listDevices: async () => [],
  onComputersChanged: () => () => {},
  onComputerEvent: (callback) => (computerEvents.add(callback), () => computerEvents.delete(callback)),
  computers: {
    list: async () => ({ thisMac: "victor-mbp", computers: window.computerList }),
    setEnabled: async () => {},
    invoke: async (id, method) => (method === "daemon:status" ? { version: "0.121.0" } : method === "project:recent" ? [] : null),
    note: async (id, line) => void (window.notes ??= []).push(line),
  },
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
updateSettings({ defaultModelId: "claude-opus-5-5", defaultPermissionMode: "ask", otherComputers: true, chatList: "grouped" });
window.oneList = () => updateSettings({ chatList: "list" });
const { default: App } = await import("/src/App");
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-sidebar-hidden-workspace-")));
  await app.whenReady();
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
  const KEY = "c-atlas|/Users/a/atlas-web";
  const LINK = "milagre-link:c-atlas|11111111-2222-4333-8444-555555555555";
  const rows = (scope) =>
    evaluate(`[...document.querySelectorAll('[data-sidebar-scope="${scope}"] [data-chat-id]')].map((row) => row.dataset.chatId).join(",")`);
  const current = () => evaluate(`document.querySelector('[data-sidebar-scope][data-current]')?.dataset.sidebarScope ?? null`);
  // Opens a Chat from the sidebar on screen and returns every list the remote Project's group showed while it settled.
  const open = async (scope, id) => {
    await evaluate(`document.querySelector('[data-sidebar-scope="${scope}"] [data-chat-id="${id}"] [data-row]').click()`);
    const seen = [];
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const value = await rows(KEY);
      if (seen.at(-1) !== value) seen.push(value);
      await delay(15);
    }
    assert.equal(await current(), scope);
    return seen;
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="${KEY}"] [data-chat-id]') && !document.querySelector('.startup-splash-screen')`, 20000);
    // Both workspaces mount: the Link's from the Project's sidebar, the Project's from the Link's.
    await evaluate("window.scopeDelay = 400");
    assert.deepEqual(await open(LINK, "3"), ["4"], "a new Link sidebar keeps the remote list while its own reads are pending");
    assert.deepEqual(await open(KEY, "4"), ["4"]);
    await open(LINK, "3");
    await evaluate(`window.pushRemote([4, 5])`);
    await waitFor(`[...document.querySelectorAll('[data-sidebar-scope="${KEY}"] [data-chat-id]')].length === 2`);
    assert.deepEqual(await open(KEY, "5"), ["5,4"]);
    await evaluate(`window.pushRemote([4, 5, 6])`);
    await waitFor(`[...document.querySelectorAll('[data-sidebar-scope="${KEY}"] [data-chat-id]')].length === 3`);
    // The Link's sidebar was hidden when chat 6 came: it lists it from the first frame, not the two Chats it froze with.
    assert.deepEqual(await open(LINK, "3"), ["6,5,4"], "the Link's sidebar shows the Chat that came while the Project was on screen");
    await screenshot("link-after-remote-change");
    assert.deepEqual(await open(KEY, "6"), ["6,5,4"]);
    // Enough rows to scroll. The second workspace must start at the same offset, even while its lists reload.
    await evaluate("window.oneList(); window.pushRemote(Array.from({length: 25}, (_, i) => i + 4))");
    await waitFor('document.querySelectorAll("aside [data-chat-id]").length >= 27');
    await evaluate('document.querySelector(".sidebar-scroll").scrollTop = 300');
    await delay(50);
    const before = await evaluate('[...document.querySelectorAll("aside [data-chat-id]")].map(row => row.dataset.chatId).join(",")');
    await evaluate(`document.querySelector('aside [data-chat-id="3"] [data-row]').click()`);
    const frames = await evaluate(`new Promise(resolve => {
      const seen = [];
      const end = performance.now() + 700;
      const read = () => {
        seen.push({ rows: [...document.querySelectorAll('aside [data-chat-id]')].map(row => row.dataset.chatId).join(','), top: document.querySelector('.sidebar-scroll')?.scrollTop });
        if (performance.now() < end) requestAnimationFrame(read); else resolve(seen);
      };
      requestAnimationFrame(read);
    })`);
    assert.ok(frames.length > 2);
    assert.ok(
      frames.every((frame) => frame.rows === before),
      "every frame keeps all rows in order during a slow Link switch",
    );
    assert.ok(
      frames.every((frame) => frame.top === 300),
      "every frame keeps the sidebar's scroll offset: " + JSON.stringify([...new Set(frames.map((frame) => frame.top))]),
    );
    await screenshot("one-list-after-link-switch");
    assert.equal(await evaluate("window.notes ?? null"), null, "every open found its Chat in the Project's copy: nothing for daemon.log");
    assert.deepEqual(errors, []);
    console.log("PASS: switching between a Link and another computer's Project lists the remote Chats that came meanwhile, in both sidebars");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors.slice(0, 10));
    await screenshot("failure").catch(() => {});
    console.error(await evaluate(`document.body.innerText.slice(0, 1500)`));
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-repro-link-remote"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "sidebar-hidden-workspace-fixture",
        resolveId(id) {
          if (id === "/__sidebar-hidden-workspace.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar-hidden-workspace.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url.split("?")[0] !== "/__sidebar-hidden-workspace") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__sidebar-hidden-workspace.tsx"></script></body></html>',
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
    const unthrottled = ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"];
    const child = require("node:child_process").spawn(
      require("electron"),
      [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar-hidden-workspace`, ...unthrottled],
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
