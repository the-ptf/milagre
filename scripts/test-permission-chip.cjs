// Real App, isolated agent IPC. A Chat another Chat started (MCP, Delegation) has no permission pick of its own:
// while its turn runs, the chip shows the mode the agent runs in, not the default for new Chats.
// Run with node scripts/test-permission-chip.cjs. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
const state = { next_id: 8, projects: { 1: { id: 1, name: 'Milagre' } }, worktrees: { 1: { id: 1, name: 'main', path: '/fixture', project_id: 1 } }, sessions: { 3: { id: 3, worktree_id: 1, agent_name: 'Claude', provider: 'claude', status: 'Idle' }, 5: { id: 5, worktree_id: 1, agent_name: 'Other', provider: 'claude', status: 'Idle' } }, connections: {}, events: [], messages: [{ id: 4, session_id: 3, role: 'user', body: 'Review PR 10923', context: null, model: 'claude-opus-5-5' }, { id: 6, session_id: 5, role: 'user', body: 'Other chat', context: null }], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
window.listeners = [];
window.emitAgent = event => {
  const ended = ['turn-completed', 'turn-failed', 'turn-cancelled'].includes(event.type);
  window.listeners.forEach(fn => fn({ chatId: '/fixture#3', event, ...(ended ? { state: { ...state } } : {}) }));
};
window.milagre = new Proxy({
  readContextSettings: async () => ({ buttonThreshold: 70, autoThreshold: 85, autoCompact: false }),
  simulators: { list: async () => ({ devices: [], supported: true }) },
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getCurrentProject: async () => ({ path: '/fixture', name: 'Milagre', state }),
  listRecentProjects: async () => [], listBranches: async () => ['main'], listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }), readUsage: async () => ({ providers: [] }), getUpdateState: async () => ({ status: 'idle' }),
  setAgentPermissionMode: async (chatId, mode) => { window.modeSet = { chatId, mode }; },
  onAgentEvent: fn => { window.listeners.push(fn); return () => { window.listeners = window.listeners.filter(x => x !== fn); }; },
}, { get(target, key) { return target[key] ?? (String(key).startsWith('on') ? () => () => {} : async () => null); } });
// New Chats start in Full on this device.
localStorage.setItem('milagre-settings', JSON.stringify({ theme: 'dark', defaultPermissionMode: 'full' }));
const { default: App } = await import('/src/App');
createRoot(document.getElementById('root')).render(<App />);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-permission-chip-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
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
  const chip = () => evaluate(`document.querySelector('[aria-label="Agent permissions"]').textContent.trim()`);
  const emit = (event) => evaluate(`window.emitAgent(${JSON.stringify(event)})`);
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(900);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(String.raw`!!document.querySelector("[data-prompt-editor]")`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(String.raw`document.querySelector("[aria-current=page]")?.textContent.includes("Review PR 10923")`);
    assert.equal(await chip(), "Full", "an idle Chat with no pick shows the default");

    // Another Chat's agent started this one through the MCP, in Ask.
    await emit({ type: "message-sent", model: "claude-opus-5-5", permissionMode: "ask" });
    await emit({ type: "turn-started", turnId: "t-1" });
    await emit({
      type: "permission-request",
      requestId: "r-1",
      kind: "command",
      tool: "Bash",
      title: "Run this command?",
      description: "Fetch PR review comments and body",
      command: "gh pr view 10923 --json body -q .body",
      allowForChat: true,
    });
    await waitFor(String.raw`document.body.textContent.includes("Fetch PR review comments and body")`);
    await waitFor(String.raw`document.querySelector('[aria-label="Agent permissions"]').textContent.trim() === "Ask"`);
    await screenshot("running-in-ask");

    // Once the turn ends, the chip is the mode the next message sends: the default again.
    await emit({ type: "turn-completed", turnId: "t-1" });
    await waitFor(String.raw`document.querySelector('[aria-label="Agent permissions"]').textContent.trim() === "Full"`);

    // A mode picked for the Chat wins over the run's.
    await emit({ type: "message-sent", model: "claude-opus-5-5", permissionMode: "ask" });
    await waitFor(String.raw`document.querySelector('[aria-label="Agent permissions"]').textContent.trim() === "Ask"`);
    await evaluate(`document.querySelector('[aria-label="Agent permissions"]').click()`);
    await waitFor(String.raw`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("Auto mode"))`);
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Auto mode")).click()`);
    await waitFor(String.raw`document.querySelector('[aria-label="Agent permissions"]').textContent.trim() === "Auto"`);
    assert.deepEqual(await evaluate("window.modeSet"), { chatId: "/fixture#3", mode: "auto" });
    await screenshot("picked-auto");

    assert.deepEqual(errors, []);
    console.log("Permission chip checks passed.");
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure").catch(() => {});
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
        name: "permission-chip-fixture",
        resolveId(id) {
          if (id === "/__chip.tsx") return id;
        },
        load(id) {
          if (id === "/__chip.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__chip") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__chip.tsx"></script></body></html>'),
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chip`], { env, stdio: "inherit" });
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
