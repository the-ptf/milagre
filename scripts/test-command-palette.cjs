// Real App, isolated IPC: keyboard routing, command dispatch, focus and responsive layout.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
// Match the real desktop shortcuts: Command on macOS, Control on Linux and Windows.
const mac = process.platform === "darwin";
const modifierKey = mac ? "Meta" : "Control";
const modifier = mac ? { metaKey: true } : { ctrlKey: true };
const changesHint = mac ? "Command + Shift + D" : "Shift + D";
const changesShortcut = mac ? "Command + Shift + D" : "Control + Shift + D";

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
// A project's state as the main process reads it.
const state = { next_id: 1, projects: { 1: { id: 1, name: 'Milagre' } }, worktrees: {}, sessions: {}, connections: {}, events: [], messages: [], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
state.worktrees = { 1: { id: 1, name: 'feature/palette', path: '/fixture/palette', project_id: 1 } };
state.sessions = {
  2: { id: 2, worktree_id: 1, agent_name: 'Claude', provider: 'claude', status: 'Idle', title: 'Relay deploy' },
  3: { id: 3, worktree_id: 1, agent_name: 'Claude', provider: 'claude', status: 'Idle' },
};
state.messages = [
  { id: 1, session_id: 2, role: 'user', body: 'Ship it', context: null },
  { id: 2, session_id: 2, role: 'assistant', body: 'The relay deploys with wrangler from apps/relay, then /health answers.', context: null },
  { id: 4, session_id: 3, role: 'user', body: 'Add a command palette', context: null },
];
state.next_id = 5;
window.calls = [];
window.escapes = 0;
window.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) window.escapes++; });
window.agentEvent = payload => window.agentHandlers.forEach(handler => handler(payload));
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  // The main process always answers with a map of chat id to ports; null would crash the ports hook.
  getAgentPorts: async () => ({}),
  patchChat: async () => { throw new Error("Chat could not be saved: disk full"); },
  // The check raises a question in the open chat by sending the events the main process would.
  getRuns: async () => ({ seq: 0, runs: {} }),
  onAgentEvent: handler => { (window.agentHandlers ??= []).push(handler); return () => {}; },
  getCurrentProject: async () => ({ path: '/fixture', name: 'Milagre', state }),
  listRecentProjects: async () => [{ path: '/fixture', name: 'Milagre' }, { path: '/other', name: 'Website' }],
  listBranches: async () => ['main'],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: 'idle' }),
  revealInFolder: async folder => window.calls.push(folder),
  switchProject: async folder => { window.calls.push(folder); return null; },
}, { get(target, key) { return target[key] ?? (String(key).startsWith('on') ? () => () => {} : async () => null); } });
localStorage.setItem('milagre-settings', JSON.stringify({ theme: 'dark' }));
const { default: App } = await import('/src/App');
createRoot(document.getElementById('root')).render(<App />);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-command-palette-")));
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1280,
    height: 760,
    // Keep animation frames advancing under Xvfb, including reduced-motion dialog exits.
    show: true,
    webPreferences: { partition: "command-palette-test", backgroundThrottling: false },
  });
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(`${error.message}\nExpression: ${source}`);
    });
  async function waitFor(source) {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error(`Timed out: ${source}`);
  }
  const key = (key, extra = {}) =>
    evaluate(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} }))`,
    );
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(200);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name), (await window.webContents.capturePage()).toPNG());
  }
  const open = async (extra = modifier) => {
    await key("k", extra);
    await waitFor('!!document.querySelector("dialog[open] input")');
  };
  const search = async (text) => {
    await evaluate(
      `(() => { const input = document.querySelector('dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    await delay(60);
  };
  try {
    await window.loadURL(process.argv[2]);
    assert.equal(await evaluate("/Mac/.test(navigator.userAgent)"), mac, "The check uses the renderer platform without a user-agent override");
    await waitFor('!!document.querySelector("[aria-label=\\"Command palette\\"]")');
    await evaluate('document.querySelector("[data-prompt-editor]").focus()');
    assert.ok(
      await evaluate('document.querySelector("[aria-label=\\\"Command palette\\\"]").textContent.includes("Search")'),
      "Search is a visible command-palette entry",
    );
    // A shown Xvfb window can open under the pointer; keep hover tooltips out of hint counts.
    window.webContents.sendInputEvent({ type: "mouseMove", x: 1000, y: 400 });
    await waitFor('document.querySelectorAll("[data-shortcut-hint]").length === 0');
    await key(modifierKey, modifier);
    await waitFor('document.querySelectorAll("[data-shortcut-hint]").length > 0');
    await screenshot("hints-dark.png");
    await evaluate('document.documentElement.classList.remove("dark")');
    await screenshot("hints-light.png");
    await evaluate('document.documentElement.classList.add("dark")');
    assert.ok(
      await evaluate(
        '[...document.querySelectorAll("kbd[data-shortcut-hint]")].every(el => getComputedStyle(el).fontFamily === getComputedStyle(document.body).fontFamily)',
      ),
      "Shortcut hints use the app font instead of the browser monospace default",
    );
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(`kbd[aria-label="${changesHint}"]`)}).querySelectorAll("svg").length`),
      mac ? 2 : 1,
      "The Changes badge draws the native modifier and Shift icons",
    );
    assert.ok(
      await evaluate(
        '[...document.querySelectorAll("kbd[data-shortcut-hint]")].every(el => { const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; })',
      ),
      "Floating badges stay inside the viewport",
    );
    await evaluate('document.querySelector("[data-changes-toggle]").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))');
    await waitFor('!!document.querySelector("[role=tooltip] kbd")');
    assert.equal(
      await evaluate('document.querySelector("[role=tooltip] kbd").getAttribute("aria-label")'),
      changesShortcut,
      "Hover tooltips name the modifier icons for assistive technology",
    );
    await screenshot("tooltip-dark.png");
    await evaluate(
      'document.querySelector("[data-changes-toggle]").dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }))',
    );
    assert.ok(
      await evaluate('[...document.querySelectorAll("[data-shortcut-hint]")].some(el => el.textContent.includes("1"))'),
      "Holding the native modifier reveals chat numbers",
    );
    await evaluate(`window.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(modifierKey)}, bubbles: true }))`);
    await waitFor('document.querySelectorAll("[data-shortcut-hint]").length === 0');
    await key(modifierKey, modifier);
    await waitFor('document.querySelectorAll("[data-shortcut-hint]").length > 0');
    await evaluate("window.dispatchEvent(new Event('blur'))");
    await waitFor('document.querySelectorAll("[data-shortcut-hint]").length === 0');
    await key(modifierKey, { ...modifier, repeat: true });
    assert.equal(await evaluate('document.querySelectorAll("[data-shortcut-hint]").length'), 0, "Key repeat after blur cannot resurrect hints");
    await key(modifierKey, modifier);
    await waitFor('document.querySelectorAll("[data-shortcut-hint]").length > 0');
    await key("n", modifier);
    await waitFor('!!document.querySelector("[data-new-chat-pickers]")');
    // Let the new-chat animation frame finish focusing the composer before the next shortcut.
    await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.equal(await evaluate('document.querySelectorAll("[data-shortcut-hint]").length'), 0, "Executing a shortcut hides hints");
    await key("1", modifier);
    await waitFor('!!document.querySelector("[aria-current=page]")');
    assert.ok(
      await evaluate('document.querySelector("[aria-current=page]").textContent.includes("Add a command palette")'),
      "The native modifier + 1 opens the first listed chat",
    );
    await key(modifierKey, modifier);
    await waitFor('document.querySelectorAll("[data-shortcut-hint]").length > 0');
    await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
    await waitFor('document.querySelectorAll("[data-shortcut-hint]").length === 0');
    await evaluate('document.querySelector("[aria-label=\\\"Command palette\\\"]").focus()');
    await open();
    assert.equal(await evaluate('document.activeElement.getAttribute("role")'), "combobox");
    assert.equal(await evaluate('document.querySelectorAll("dialog kbd").length'), 0, "Palette keycaps are hidden until the native modifier is held");
    await key(modifierKey, modifier);
    await waitFor('document.querySelectorAll("dialog kbd").length > 0');
    await screenshot("palette-hints-dark.png");
    await evaluate('document.documentElement.classList.remove("dark")');
    await screenshot("palette-hints-light.png");
    await evaluate('document.documentElement.classList.add("dark")');
    assert.equal(
      await evaluate('document.querySelectorAll("body > [data-shortcut-hint], aside [data-shortcut-hint]").length'),
      0,
      "Hints stay scoped to the open palette",
    );
    await evaluate(`window.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(modifierKey)}, bubbles: true }))`);
    await waitFor('document.querySelectorAll("dialog kbd").length === 0');
    await waitFor('document.querySelector("dialog").textContent.includes("Website")');
    await key("ArrowUp");
    assert.ok(await evaluate('document.querySelector("[aria-selected=true]").textContent.includes("Website")'), "Arrow navigation wraps");
    await key("ArrowDown");
    assert.ok(await evaluate('document.querySelector("[aria-selected=true]").textContent.includes("Commit and open PR")'));
    await key("Tab");
    assert.equal(await evaluate('document.activeElement.getAttribute("role")'), "combobox");
    await search("missing-command-xyz");
    assert.equal(await evaluate('document.querySelectorAll("dialog [role=option]").length'), 0);
    await key("Enter");
    assert.ok(await evaluate('!!document.querySelector("dialog[open]")'));
    await search("FINDER");
    await key("Enter");
    await key("Enter");
    await waitFor('window.calls.includes("/fixture/palette")');
    assert.equal(await evaluate('window.calls.filter(path => path === "/fixture/palette").length'), 1, "Repeated Enter during exit runs the command once");
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), "Command palette");
    await open(mac ? { ctrlKey: true } : { metaKey: true });
    await key("Escape");
    await waitFor('!document.querySelector("dialog")');
    assert.equal(await evaluate("window.escapes"), 0, "Escape never reaches app shortcuts");
    await open();
    await key("k", modifier);
    await waitFor('!document.querySelector("dialog")');
    await open();
    await key("Escape");
    await waitFor('!document.querySelector("dialog")');
    for (const [query, setting, value] of [
      ["mode light", "theme", "light"],
      ["mode light", "theme", "light"],
      ["MODE DARK", "theme", "dark"],
      ["mode system", "theme", "system"],
      ["usage remaining", "usageDisplay", "remaining"],
      ["sidebar usage hide", "showUsageInSidebar", false],
      ["tldr off", "tldrEnabled", false],
      ["tldr on", "tldrEnabled", true],
      ["claude replies normal", "claudeReplies", "normal"],
      ["notify finished off", "notifyOnCompletion", false],
      ["notify waiting off", "notifyWhenWaiting", false],
      ["dock badge off", "showDockBadge", false],
      ["keep awake off", "keepAwake", false],
    ]) {
      await open();
      await search(query);
      assert.ok(await evaluate('!!document.querySelector("[aria-selected=true]")'), `Command found: ${query}`);
      await key("Enter");
      await waitFor(`JSON.parse(localStorage.getItem('milagre-settings'))[${JSON.stringify(setting)}] === ${JSON.stringify(value)}`);
      await waitFor('!document.querySelector("dialog")');
      if (setting === "theme") {
        await waitFor(
          `document.documentElement.classList.contains('dark') === ${value === "system" ? "matchMedia('(prefers-color-scheme: dark)').matches" : value === "dark"}`,
        );
      }
      assert.equal(await evaluate('!!document.querySelector("[aria-label=\\"Settings navigation\\"]")'), false, "Quick changes stay in the chat");
    }
    await open();
    await search("mode dark");
    await key("Enter");
    await waitFor('!document.querySelector("dialog")');
    await waitFor("JSON.parse(localStorage.getItem('milagre-settings')).theme === 'dark' && document.documentElement.classList.contains('dark')");
    await open();
    await search("mode dark");
    assert.ok(await evaluate('document.querySelector("[aria-selected=true]").textContent.includes("Current")'), "Reopening shows the saved theme as current");
    await search("add palette");
    assert.ok(await evaluate('document.querySelector("[aria-selected=true]").textContent.includes("Add a command palette")'), "Search matches multiple words");
    // No command, chat or project matches a typo'd word from a reply, so the palette searches what was said.
    await search("wranglr");
    await waitFor('!!document.querySelector("dialog [role=group][aria-label=Messages]")');
    assert.equal(await evaluate('document.querySelector("[aria-selected=true] mark").textContent'), "wrangler", "The matched word is marked");
    assert.ok(await evaluate('document.querySelector("[aria-selected=true]").textContent.includes("Relay deploy")'), "The row names its chat");
    await screenshot("palette-messages-dark.png");
    await evaluate('document.documentElement.classList.remove("dark")');
    await screenshot("palette-messages-light.png");
    await evaluate('document.documentElement.classList.add("dark")');
    await key("Enter");
    await waitFor('!document.querySelector("dialog")');
    await waitFor('document.querySelector("[aria-label=\\"Find in chat\\"]")?.value === "wrangler"');
    assert.ok(await evaluate('document.querySelector("[aria-current=page]").textContent.includes("Relay deploy")'), "The message's chat opens");
    await waitFor('document.querySelector("[data-find-count]").textContent === "1 of 1"');
    await screenshot("message-opened-dark.png");
    await key("Escape");
    await waitFor('!document.querySelector("[data-find-bar]")');
    await open();
    await search("");
    await screenshot("palette-dark.png");
    for (const [width, height] of [
      [390, 500],
      [1000, 760],
    ]) {
      window.setContentSize(width, height);
      await evaluate('document.documentElement.classList.remove("dark")');
      await delay(100);
      assert.ok(
        await evaluate(
          '(() => { const b = document.querySelector("dialog").getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; })()',
        ),
        "Palette fits the viewport",
      );
    }
    await screenshot("palette-light.png");
    // Restore the full sidebar before later assertions on its selected Chat row.
    window.setContentSize(1280, 760);
    await search("appearance");
    await key("Enter");
    await waitFor('!!document.querySelector("[aria-label=\\"Settings navigation\\"]")');
    await open();
    assert.ok(await evaluate('!document.querySelector("dialog").textContent.includes("Commit and open PR")'), "Chat actions hidden in settings");
    await key("n", modifier);
    await waitFor('!!document.querySelector("[data-new-chat-pickers]")');
    await open();
    assert.ok(await evaluate('!document.querySelector("dialog").textContent.includes("Commit and open PR")'), "Chat actions hidden on a new draft");
    await search("website");
    await key("Enter");
    await waitFor('window.calls.includes("/other")');
    await waitFor('!document.querySelector("dialog")');
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.ok(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"));
    await open();
    await key("Escape");
    await waitFor('!document.querySelector("dialog")');
    window.webContents.debugger.detach();
    // A chat waiting on a question is not a modal: the shortcuts keep working over the card.
    await key("1", modifier);
    await waitFor('!!document.querySelector("[aria-current=page]")');
    await evaluate("window.agentEvent({ chatId: '/fixture#3', event: { type: 'turn-started' }, seq: 1 })");
    await evaluate(
      "window.agentEvent({ chatId: '/fixture#3', seq: 2, event: { type: 'question-request', requestId: 'q-1', questions: [{ id: 'review', header: 'Review', question: 'How should the review step work?', options: [{ label: 'Brief in composer' }, { label: 'Review card' }], multiSelect: false, allowOther: true, secret: false }] } })",
    );
    await waitFor('!!document.querySelector("[aria-label=\\"Agent question\\"]")');
    await open();
    assert.ok(await evaluate('!!document.querySelector("[aria-label=\\"Agent question\\"]")'), "The question card stays while the palette is open");
    await screenshot("palette-over-question.png");
    await key("Escape");
    await waitFor('!document.querySelector("dialog")');
    await key("n", modifier);
    await waitFor('!!document.querySelector("[data-new-chat-pickers]")');
    // A failed row action reports the cause in the actual App, with the Chat still present.
    await key("1", modifier);
    await evaluate(`window.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(modifierKey)}, bubbles: true }))`);
    await evaluate(`document.querySelector('[aria-label="Expand sidebar"]')?.click()`);
    await waitFor(`!!document.querySelector('[aria-label="Chat actions"]')`);
    await evaluate(`document.querySelector('[aria-label="Chat actions"]').click()`);
    await waitFor('!!document.querySelector("[data-chat-menu]")');
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.includes('Mark as unread')).click()`);
    await waitFor(`document.body.textContent.includes('Could not update Chat: Chat could not be saved: disk full')`);
    assert.ok(await evaluate('document.body.textContent.includes("Add a command palette")'));
    await screenshot("chat-action-failure.png");
    console.log(
      "PASS: Cmd/Ctrl+K, fuzzy message fallback opening the chat with find seeded, animated exit, reduced-motion dismissal, repeated Enter guard, direct settings changes and persistence, current setting, filtering, navigation, empty state, action dispatch, focus restore, Escape isolation, modifier-only hints, release/blur cleanup, numbered chat navigation, themes, viewport fit, settings and project navigation, shortcuts over a waiting question card",
    );
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
        name: "command-palette-fixture",
        resolveId(id) {
          if (id === "/__commands.tsx") return id;
        },
        load(id) {
          if (id === "/__commands.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__commands") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__commands.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__commands`], { env, stdio: "inherit" });
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
