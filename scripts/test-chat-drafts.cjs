// Every Chat, and the new-chat screen, keeps its own draft while you move between them,
// and Up/Down in the prompt step through the prompts sent in that Chat.
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { openRenderer } = require("./renderer-ready.cjs");
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
const state = { next_id: 1, projects: { 1: { id: 1, name: "Fixture" } }, worktrees: {}, sessions: {}, connections: {}, events: [], messages: [], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
state.worktrees = { 1: { id: 1, name: "main", path: "/fixture", project_id: 1 } };
state.sessions = {
  3: { id: 3, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle" },
  5: { id: 5, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle" },
};
state.messages = [
  { id: 4, session_id: 3, role: "user", body: "Alpha chat", context: null },
  { id: 6, session_id: 5, role: "user", body: "Beta chat", context: null },
  { id: 7, session_id: 3, role: "user", body: "Second alpha prompt", context: null },
  { id: 8, session_id: 3, role: "user", body: "Commit the changes", context: { kind: "git-action" } },
];
state.next_id = 9;
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getCurrentProject: async () => ({ path: "/fixture", name: "Fixture", state }),
  listRecentProjects: async () => [
    { path: "/fixture", name: "Fixture", openedAt: "" },
    { path: "/second", name: "Second", openedAt: "" },
  ],
  readProject: () => new Promise(() => {}),
  switchProject: (path) => new Promise((resolve, reject) => {
    window.finishProjectSwitch = () => resolve({ path, name: "Second", state: { ...state, sessions: {}, messages: [], worktrees: { 1: { id: 1, name: "main", path, project_id: 1 } } } });
    window.failProjectSwitch = () => reject(new Error("Computer unavailable"));
  }),
  listBranches: async () => ["main"],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: "idle" }),
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
const { default: App } = await import("/src/App");
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { partition: "chat-drafts-test", backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error(`Timed out: ${source}`);
  }
  const prompt = `document.querySelector('[data-prompt-editor]')`;
  const type = (text) =>
    evaluate(`(() => {
      const input = ${prompt};
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  const promptIs = (text) => waitFor(`${prompt}?.value === ${JSON.stringify(text)}`);
  const press = (key) => evaluate(`${prompt}.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true, cancelable: true }))`);
  const setPermissionMode = async (mode) => {
    // Mode is "Ask", "Auto", or "Full"
    // Wait for the permission mode dropdown and click it
    await evaluate(
      `[...document.querySelectorAll('button')].find(b => b.textContent === 'Ask' || b.textContent === 'Auto' || b.textContent === 'Full')?.click()`,
    );
    await waitFor(`!![...document.querySelectorAll('button[data-picker-row]')].find(b => b.textContent.includes('${mode}'))`);
    await evaluate(`[...document.querySelectorAll('button[data-picker-row]')].find(b => b.textContent.includes('${mode}'))?.click()`);
    // Wait for it to apply
    await waitFor(`[...document.querySelectorAll('button')].find(b => b.textContent === '${mode}')`);
  };
  const expectPermissionMode = async (mode) => {
    await waitFor(`[...document.querySelectorAll('button')].find(b => b.textContent === '${mode}')`);
  };
  async function openChat(title) {
    const row = `[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes(${JSON.stringify(title)}))`;
    await waitFor(`!!(${row})`);
    await evaluate(`(${row}).click()`);
    await waitFor(`document.querySelector('[aria-label="Conversation"]')?.textContent.includes(${JSON.stringify(title)})`);
  }
  const newChat = async () => {
    await evaluate(`document.querySelector('[aria-label="New chat"]').click()`);
    await waitFor(`!!document.querySelector('[data-new-chat-pickers]')`);
  };
  async function screenshot(name) {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (!dir) return;
    // The splash fades out and the window repaints after a selection; capture what is on screen, not the last frame.
    await delay(400);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  try {
    await openRenderer(window, process.argv[2], `!!document.querySelector('[aria-label="New chat"]')`);
    await openChat("Alpha chat");
    await type("Draft for alpha");
    await promptIs("Draft for alpha");
    await screenshot("alpha-draft");
    await openChat("Beta chat");
    await promptIs("");
    await screenshot("beta-empty");
    await type("Draft for beta");
    await openChat("Alpha chat");
    await promptIs("Draft for alpha");
    await openChat("Beta chat");
    await promptIs("Draft for beta");
    console.log("PASS: a draft stays in the Chat it was typed in");
    await newChat();
    await promptIs("");
    await type("Draft for a new chat");
    await openChat("Alpha chat");
    await promptIs("Draft for alpha");
    await newChat();
    await promptIs("Draft for a new chat");
    await screenshot("new-chat-restored");
    console.log("PASS: the new-chat draft comes back after visiting another Chat");

    await openChat("Alpha chat");
    await promptIs("Draft for alpha");
    await press("ArrowUp");
    await promptIs("Second alpha prompt");
    await press("ArrowUp");
    await promptIs("Alpha chat");
    await press("ArrowUp");
    await promptIs("Alpha chat");
    await screenshot("history-oldest");
    await press("ArrowDown");
    await promptIs("Second alpha prompt");
    await press("ArrowDown");
    await promptIs("Draft for alpha");
    await press("ArrowDown");
    await promptIs("Draft for alpha");
    console.log("PASS: Up and Down step through the Chat's sent prompts and restore the draft");

    // Test permission mode options
    await openChat("Alpha chat");
    await setPermissionMode("Auto");
    await openChat("Beta chat");
    await expectPermissionMode("Ask");
    await setPermissionMode("Full");
    await openChat("Alpha chat");
    await expectPermissionMode("Auto");
    await openChat("Beta chat");
    await expectPermissionMode("Full");
    await screenshot("beta-permission-full");
    console.log("PASS: permission mode is attached to each chat separately");

    await newChat();
    await type("Keep this draft visible");
    await evaluate(`document.querySelector('[data-new-chat-project]').click()`);
    const second = `[...document.querySelectorAll('[data-new-chat-heading] [data-picker-row]')].find(row => row.querySelector('strong')?.textContent === 'Second')`;
    await waitFor(`!!(${second})`);
    await evaluate(`(${second}).click()`);
    await waitFor(`typeof window.finishProjectSwitch === 'function'`);
    await promptIs("Keep this draft visible");
    await type("Edited while connecting");
    await evaluate(`window.failProjectSwitch()`);
    await waitFor(`document.body.textContent.includes('Computer unavailable')`);
    await promptIs("Edited while connecting");
    await evaluate(`window.finishProjectSwitch = null; document.querySelector('[data-new-chat-project]').click()`);
    await waitFor(`!!(${second})`);
    await evaluate(`(${second}).click()`);
    await waitFor(`typeof window.finishProjectSwitch === 'function'`);
    await evaluate(`window.finishProjectSwitch()`);
    await waitFor(`document.querySelector('[data-new-chat-project]')?.textContent.includes('Second')`);
    await promptIs("Edited while connecting");
    console.log("PASS: a slow or failed Project switch keeps the draft visible and carries edits made during the wait");
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
        name: "chat-drafts-fixture",
        resolveId(id) {
          if (id === "/__chat_drafts_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_drafts_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__chat_drafts__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__chat_drafts_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat_drafts__`], { env, stdio: "inherit" });
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
