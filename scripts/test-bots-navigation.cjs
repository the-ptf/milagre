// Real App, stubbed bridge: the Projects | Bots switch next to Routines. With the bot thread on screen, Escape leaves the
// turn running in the Chat behind it, and with the sidebar collapsed its header clears the sidebar toggle. Bots from the Routines page shows the bot thread; Routines opens from the palette
// in Bots, and its Heartbeat's Open Chat lands in that Chat with the sidebar back on Projects.
// Run with node scripts/test-bots-navigation.cjs. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { openRenderer } = require("./renderer-ready.cjs");
const fixture = `
localStorage.setItem("milagre.sidebarMode", "bots");
// The traffic lights' room on macOS, which puts the sidebar toggle over <main> once the sidebar collapses.
const titlebar = new EventTarget();
titlebar.visible = true;
titlebar.getTitlebarAreaRect = () => new DOMRect(80, 0, innerWidth - 80, 60);
Object.defineProperty(navigator, "windowControlsOverlay", { value: titlebar });
window.milagreWindowChrome = { controls: "leading" };
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
const HOME = '/d/bots/ops';
const state = { next_id: 8, projects: { 1: { id: 1, name: 'Milagre' } }, worktrees: { 1: { id: 1, name: 'main', path: '/fixture', project_id: 1 } }, sessions: { 3: { id: 3, worktree_id: 1, agent_name: 'Claude', provider: 'claude', status: 'Idle' }, 5: { id: 5, worktree_id: 1, agent_name: 'Other', provider: 'claude', status: 'Idle' } }, connections: {}, events: [], messages: [{ id: 4, session_id: 3, role: 'user', body: 'Review PR 10923', context: null }, { id: 6, session_id: 5, role: 'user', body: 'Watch CI on 461', context: null }], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
const BOT_MESSAGES = [{ id: 1, session_id: 1, role: 'assistant', body: 'main is green. Nothing waits on you.', context: null }];
const ops = { id: 'ops', name: 'Ops', role: 'Keeps main green and PRs moving', color: '#3b82f6', body: 'circle', provider: 'claude', model: 'claude-opus-5-5',
  projects: ['/fixture'], paused: false, homePath: HOME, homeWorktreeId: 1, threadSessionId: 1, createdAt: 1, preview: 'main is green', lastAt: Date.now(), unread: false, pendingGates: 0 };
const now = Date.now();
const heartbeat = { id: 'h1', name: 'Watch CI on 461', prompt: 'Check', enabled: true, createdBy: { kind: 'user' }, runCount: 0, createdAt: now, updatedAt: now, runs: [],
  trigger: { kind: 'schedule', cron: '*/10 * * * *', timezone: 'UTC' }, target: { kind: 'chat', chatId: '/fixture#5' }, nextRunAt: now + 600000 };
window.listeners = [];
window.emitAgent = (chatId, event) => window.listeners.forEach(fn => fn({ chatId, event }));
window.interrupted = [];
window.milagre = new Proxy({
  simulators: { list: async () => ({ devices: [], supported: true }) },
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getCurrentProject: async () => ({ path: '/fixture', name: 'Milagre', state }),
  listRecentProjects: async () => [], listBranches: async () => ['main'], listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }), readUsage: async () => ({ providers: [] }), getUpdateState: async () => ({ status: 'idle' }),
  readChatMessages: async (scope, id) => {
    const messages = scope === HOME ? BOT_MESSAGES : state.messages.filter((message) => message.session_id === id);
    return { messages, hasMore: false, total: messages.length };
  },
  readBotsEnabled: async () => ({ enabled: true }),
  listBots: async () => ({ enabled: true, bots: [ops], gates: [], grants: [], chats: [] }),
  readRoutinesEnabled: async () => ({ enabled: true }),
  listRoutines: async () => ({ routines: [heartbeat] }),
  routineTargets: async () => ({ projects: [{ path: '/fixture', name: 'Milagre', chats: [{ chatId: '/fixture#5', title: 'Watch CI on 461', lastAt: now }] }] }),
  readBotBrief: async () => ({ text: 'Watch main.' }),
  readBotMemory: async () => ({ text: '', lines: 0, bytes: 0 }),
  interruptAgent: async (chatId) => { window.interrupted.push(chatId); },
  onAgentEvent: fn => { window.listeners.push(fn); return () => { window.listeners = window.listeners.filter(x => x !== fn); }; },
}, { get(target, key) { return target[key] ?? (String(key).startsWith('on') ? () => () => {} : async () => null); } });
localStorage.setItem('milagre-settings', JSON.stringify({ theme: 'dark' }));
const { default: App } = await import('/src/App');
createRoot(document.getElementById('root')).render(<App />);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-bots-navigation-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1200, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const key = (key, extra = {}) =>
    evaluate(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} }))`,
    );
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(300);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const threadShown = `!!document.querySelector('[data-bot-thread="ops"]')`;
  const chatPaneShown = `!document.querySelector('[data-chat-pane]')?.classList.contains('hidden')`;
  try {
    await openRenderer(window, process.argv[2], threadShown);
    assert.equal(await evaluate(chatPaneShown), false, "the bot thread takes the Chat's place");
    assert.equal(await evaluate(`!!document.querySelector('[data-sidebar-routines]')`), false, "Bots lists bots, not the tools row");
    await screenshot("bots-navigation-thread");

    // Collapsed, the thread's header starts after the sidebar toggle instead of under it. The header learns <main> moved
    // from a ResizeObserver, which runs with a frame; a hidden window on Linux paints none until one is captured.
    await click('[aria-label="Collapse sidebar"]');
    await waitFor(`Math.round(document.querySelector("aside").getBoundingClientRect().width) === 44`);
    const readHeader = `(() => { const toggle = document.querySelector('[data-sidebar-toggle] button').getBoundingClientRect(); const title = document.querySelector('[data-bot-thread="ops"] header h1').getBoundingClientRect(); return { toggleRight: toggle.right, titleLeft: title.left }; })()`;
    let header;
    for (let n = 0; n < 20; n++) {
      await window.webContents.capturePage();
      header = await evaluate(readHeader);
      if (header.titleLeft >= header.toggleRight) break;
      await delay(50);
    }
    assert.ok(header.titleLeft >= header.toggleRight, `the bot's name clears the sidebar toggle: ${JSON.stringify(header)}`);
    await screenshot("bots-navigation-collapsed");
    await click('[aria-label="Expand sidebar"]');
    await waitFor(`Math.round(document.querySelector("aside").getBoundingClientRect().width) > 44`);

    // Both Chats behind the bot thread run a turn; Escape on the thread stops neither.
    for (const chatId of ["/fixture#3", "/fixture#5"]) {
      await evaluate(`window.emitAgent(${JSON.stringify(chatId)}, { type: "message-sent", model: "claude-opus-5-5", permissionMode: "ask" })`);
      await evaluate(`window.emitAgent(${JSON.stringify(chatId)}, { type: "turn-started", turnId: "t-1" })`);
    }
    await delay(100);
    await evaluate(`document.body.focus()`);
    await key("Escape");
    await delay(100);
    assert.deepEqual(await evaluate(`window.interrupted`), [], "Escape on the bot thread leaves the hidden Chat's turn running");

    // Projects › Routines, then Bots: the bot thread, not the Routines page.
    await click('[data-sidebar-mode="projects"]');
    await waitFor(chatPaneShown);
    await waitFor(`!!document.querySelector('[data-sidebar-routines]')`);
    await click("[data-sidebar-routines]");
    await waitFor(`!!document.querySelector('[data-routine-row="h1"]')`);
    await click('[data-sidebar-mode="bots"]');
    await waitFor(threadShown);
    assert.equal(await evaluate(`!!document.querySelector('[data-routines-page]')`), false, "Bots leaves the Routines page for the bot thread");

    // Routines from the palette while in Bots, then its Heartbeat's Open Chat: that Chat, on Projects.
    await key("k", { metaKey: true });
    await waitFor('!!document.querySelector("dialog[open] input")');
    await evaluate(
      `(() => { const input = document.querySelector('dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Routines'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    await delay(60);
    await key("Enter");
    await waitFor(`!!document.querySelector('[data-routine-row="h1"]')`);
    assert.equal(await evaluate(threadShown), false, "Routines shows over Bots");
    await screenshot("bots-navigation-routines");
    await click('[data-routine-row="h1"] [data-routine-more]');
    await waitFor(`!!document.querySelector('[data-routine-menu]')`);
    await evaluate(`[...document.querySelectorAll('[data-routine-menu] [data-menu-row]')].find((row) => row.textContent.includes('Open Chat')).click()`);
    await waitFor(chatPaneShown);
    assert.equal(await evaluate(threadShown), false, "Open Chat leaves the bot thread");
    assert.equal(await evaluate(`!!document.querySelector('[data-routines-page]')`), false);
    await waitFor(`document.querySelector('[data-sidebar-mode="projects"]')?.getAttribute('aria-pressed') === 'true'`);
    await waitFor(`document.querySelector("[aria-current=page]")?.textContent.includes("Watch CI on 461")`);
    await screenshot("bots-navigation-chat");
    assert.deepEqual(errors, []);
    console.log("Bots navigation checks passed.");
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (error.code !== "ERR_RENDERER_READINESS") await screenshot("failure").catch(() => {});
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
        name: "bots-navigation-fixture",
        resolveId(id) {
          if (id === "/__bots-navigation.tsx") return id;
        },
        load(id) {
          if (id === "/__bots-navigation.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__bots-navigation") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__bots-navigation.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__bots-navigation`], { env, stdio: "inherit" });
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
