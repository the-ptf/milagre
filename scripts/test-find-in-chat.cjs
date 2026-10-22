// Run with node scripts/test-find-in-chat.cjs. Mirrors test-subagents.cjs: Vite serves a ChatComposer fixture
// to an isolated Electron window (own port, throwaway profile). Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

// Match the real desktop shortcuts: Command on macOS, Control on Linux and Windows.
const COMMAND = process.platform === "darwin" ? "meta" : "control";

const fixture = `
window.milagre = Object.freeze({ listEditors: async () => [] });
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
const filler = "The migration touches the session store and the reply renderer, so each step is checked against the fixtures before moving on. ".repeat(6);
const bodies = [
  "Please review the sidebar. Needle one lives in this request.",
  filler,
  "Reply with a needle in the middle of a sentence. " + filler,
  filler + " Another NEEDLE here and one more needle after it.",
  filler,
  "A closing line without the term, then a last needle.",
  "A phrase that runs across **bold text** and \`inline\` code boundaries.",
];
const messages = bodies.map((body, index) => ({ id: index + 1, session_id: 1, context: null, role: index % 2 || index === bodies.length - 1 ? "assistant" : "user", body }));
function Fixture() {
  const [findOpen, setFindOpen] = useState(false);
  const [findSignal, setFindSignal] = useState(0);
  const [draft, setDraft] = useState("");
  const [model] = useState(MODEL_CATALOG[0]);
  // Stands in for App's shortcut handler, which owns the find state in the real app.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); setFindOpen(true); setFindSignal((n) => n + 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={messages}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={false} sendBlocked={false} subagents={[]}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null}
      findOpen={findOpen} findSignal={findSignal} onFindClose={() => setFindOpen(false)} />
  </div>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const appFixture = `
// This fixture exercises a device that has already accepted AI sharing.
import { AI_CONSENT_VERSION } from "@milagre/shared/ai-consent";
localStorage.setItem("milagre.ai-sharing-consent", AI_CONSENT_VERSION);
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
// A project's state as the main process reads it.
const state = { next_id: 1, projects: { 1: { id: 1, name: "Fixture" } }, worktrees: {}, sessions: {}, connections: {}, events: [], messages: [], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
state.worktrees = { 1: { id: 1, name: "main", path: "/fixture", project_id: 1 } };
state.sessions = {
  3: { id: 3, worktree_id: 1, agent_name: "Chat one", provider: "claude", status: "Idle" },
  5: { id: 5, worktree_id: 1, agent_name: "Chat two", provider: "claude", status: "Idle" },
};
state.messages = [
  { id: 4, session_id: 3, role: "user", body: "Chat one needle and a second needle", context: null },
  { id: 6, session_id: 5, role: "user", body: "Chat two needle", context: null },
];
state.next_id = 7;
window.interrupts = [];
window.agentListeners = new Set();
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getRuns: async () => ({ seq: 0, runs: {} }),
  // The main process always answers with a map of chat id to ports; null would crash the ports hook.
  getAgentPorts: async () => ({}),
  getCurrentProject: async () => ({ path: "/fixture", name: "Fixture", state }),
  listBranches: async () => ["main"],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: "idle" }),
  listRecentProjects: async () => [],
  interruptAgent: async (chatId) => { window.interrupts.push(chatId); },
  // Stands in for the main process: it saves the message and starts the turn, which the window streams.
  onAgentEvent: (callback) => { window.agentListeners.add(callback); return () => window.agentListeners.delete(callback); },
  sendMessage: async (request) => {
    window.agentListeners.forEach((listener) => listener({ chatId: request.projectPath + "#" + request.sessionId, event: { type: "message-sent", model: request.model } }));
    return { sessionId: request.sessionId };
  },
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
// Opens a sidebar chat by its title.
window.openChatWith = (title) => [...document.querySelectorAll("button")].find((el) => el.textContent.includes(title))?.click();
const { default: App } = await import("/src/App");
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-find-ui-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 900, height: 640, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const evaluate = async (source) => {
    try {
      return await window.webContents.executeJavaScript(source);
    } catch (error) {
      throw new Error(`${source}: ${error.message}`, { cause: error });
    }
  };
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(300);
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source} (count: ${await evaluate('document.querySelector("[data-find-count]")?.textContent')})`);
  }
  const key = (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  const count = () => evaluate('document.querySelector("[data-find-count]")?.textContent ?? null');
  const activeTop = () => evaluate('(() => { const r = [...CSS.highlights.get("find-active")][0].getBoundingClientRect(); return Math.round(r.top); })()');
  const activeOffset = () =>
    evaluate(
      '(() => { const range = [...CSS.highlights.get("find-active")][0]; return range.startContainer.data.slice(0, range.startOffset).length + range.startContainer.data.length * 1000; })()',
    );
  const inView = () =>
    evaluate(
      '(() => { const v = document.querySelector("section"); const vr = v.getBoundingClientRect(); const r = [...CSS.highlights.get("find-active")][0].getBoundingClientRect(); return r.top >= vr.top && r.bottom <= vr.bottom; })()',
    );
  const setTheme = (dark) => evaluate(`document.documentElement.classList.toggle("dark", ${dark})`);
  // The same keys and shortcuts through the real App: its state, shortcut handlers and command palette.
  async function appPhase() {
    await window.loadURL(process.argv[3]);
    await waitFor('!!document.querySelector("[aria-label=\\"New chat\\"]") && !!document.querySelector("[aria-label=Conversation]")');
    const bar = '!!document.querySelector("[data-find-bar]")';
    const text = () => evaluate('document.querySelector("[aria-label=Conversation]").textContent');
    // Open chat 1 (has messages).
    await evaluate('window.openChatWith("Chat one needle")');
    await waitFor('document.querySelector("[aria-label=Conversation]").textContent.includes("Chat one needle")');
    await evaluate('document.querySelector("[data-prompt-editor]").focus()');
    key("F", [COMMAND]);
    await waitFor(bar);
    await waitFor('document.activeElement === document.querySelector("[data-find-bar] input")');
    window.webContents.insertText("needle");
    await waitFor('document.querySelector("[data-find-count]").textContent === "1 of 2"');
    await screenshot("find-app");

    // Switching chats closes the bar.
    await evaluate('window.openChatWith("Chat two needle")');
    await waitFor('document.querySelector("[aria-label=Conversation]").textContent.includes("Chat two needle")');
    await waitFor(`!(${bar})`);
    assert.equal(await evaluate("CSS.highlights.size"), 0);

    // A new, empty chat has nothing to search.
    await evaluate('document.querySelector("[aria-label=\\"New chat\\"]").click()');
    await waitFor('!!document.querySelector("[data-new-chat-pickers]")');
    key("F", [COMMAND]);
    await delay(300);
    assert.equal(await evaluate(bar), false);

    // The command palette lists Find in chat on a chat with messages, and running it opens the bar.
    await evaluate('window.openChatWith("Chat one needle")');
    await waitFor('document.querySelector("[aria-label=Conversation]").textContent.includes("Chat one needle")');
    key("K", [COMMAND]);
    await waitFor('!!document.querySelector("dialog[open][aria-label=\\"Command palette\\"]")');
    window.webContents.insertText("search text");
    await waitFor('[...document.querySelectorAll("dialog [role=option]")].some(el => el.textContent.includes("Find in chat"))');
    key("Return");
    await waitFor(bar);
    await waitFor('document.activeElement === document.querySelector("[data-find-bar] input")');
    key("Escape");
    await waitFor(`!(${bar})`);
    assert.equal(await evaluate('document.activeElement === document.querySelector("[data-prompt-editor]")'), true);

    // Escape closes the bar first; the stop-agent handler only gets the next one.
    await evaluate("window.interrupts.length = 0");
    await evaluate(
      '(() => { const i = document.querySelector("[data-prompt-editor]"); i.value = "go"; i.dispatchEvent(new Event("input", { bubbles: true })); })()',
    );
    await waitFor('!document.querySelector("[aria-label=Send]").disabled');
    await evaluate('document.querySelector("[aria-label=Send]").click()');
    // The working indicator names the model only to screen readers.
    await waitFor("!!document.querySelector('[role=status][aria-label^=\"Working with\"]')");
    key("F", [COMMAND]);
    await waitFor(bar);
    await evaluate('document.querySelector("[data-prompt-editor]").focus()');
    key("Escape");
    await waitFor(`!(${bar})`);
    await delay(200);
    assert.equal(await evaluate("window.interrupts.length"), 0, "Escape that closes the bar must not stop the agent");
    key("Escape");
    await waitFor("window.interrupts.length === 1");
    console.log(
      "PASS: real App: opens on a chat, ignores an empty new chat, closes on chat switch, palette command, Escape closes the bar before stopping the agent",
    );
  }

  try {
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-prompt-editor]")');
    await evaluate('document.querySelector("[data-prompt-editor]").focus()');
    assert.equal(await evaluate('!!document.querySelector("[data-find-bar]")'), false);

    key("F", [COMMAND]);
    await waitFor('document.activeElement === document.querySelector("[data-find-bar] input")');
    assert.equal(await count(), "");

    window.webContents.insertText("needle");
    await waitFor('document.querySelector("[data-find-count]").textContent === "1 of 5"');
    assert.equal(await evaluate('[...CSS.highlights.get("find-match")].length'), 5);
    assert.equal(await evaluate('CSS.highlights.get("find-active").size'), 1);
    // The query typed in the bar is not a match: the highlights live only in the message list.
    assert.equal(await evaluate('[...CSS.highlights.get("find-match")].every(range => !!range.startContainer.parentElement.closest(".chat-column"))'), true);
    assert.ok(await inView());
    await screenshot("find-light-first");

    const first = await activeOffset();
    key("Return");
    await waitFor('document.querySelector("[data-find-count]").textContent === "2 of 5"');
    assert.notEqual(await activeOffset(), first);
    assert.ok(await inView());
    key("Return");
    await waitFor('document.querySelector("[data-find-count]").textContent === "3 of 5"');
    assert.ok(await inView());
    const scrolled = await evaluate('document.querySelector("section").scrollTop');
    assert.ok(scrolled > 0, "next match scrolls the list");
    await screenshot("find-light-third");

    key("Return", ["shift"]);
    await waitFor('document.querySelector("[data-find-count]").textContent === "2 of 5"');
    key("G", [COMMAND]);
    await waitFor('document.querySelector("[data-find-count]").textContent === "3 of 5"');
    key("G", [COMMAND, "shift"]);
    await waitFor('document.querySelector("[data-find-count]").textContent === "2 of 5"');
    // Previous from the first wraps to the last.
    key("Return", ["shift"]);
    key("Return", ["shift"]);
    await waitFor('document.querySelector("[data-find-count]").textContent === "5 of 5"');
    assert.ok(await inView());

    // A match may cross inline markup.
    await evaluate('document.querySelector("[data-find-bar] input").select()');
    window.webContents.insertText("across bold text and inline");
    await waitFor('document.querySelector("[data-find-count]").textContent === "1 of 1"');
    assert.equal(
      await evaluate(
        '(() => { const r = [...CSS.highlights.get("find-active")][0]; return r.startContainer !== r.endContainer && r.toString() === "across bold text and inline"; })()',
      ),
      true,
    );
    await evaluate('document.querySelector("[data-find-bar] input").select()');
    window.webContents.insertText("needle");
    await waitFor('document.querySelector("[data-find-count]").textContent === "1 of 5"');
    key("Return", ["shift"]);
    await waitFor('document.querySelector("[data-find-count]").textContent === "5 of 5"');

    // Reopening with the bar open selects the field text.
    await evaluate('document.querySelector("[data-prompt-editor]").focus()');
    key("F", [COMMAND]);
    await waitFor('document.activeElement === document.querySelector("[data-find-bar] input")');
    assert.equal(
      await evaluate(
        '(() => { const i = document.querySelector("[data-find-bar] input"); return i.selectionStart === 0 && i.selectionEnd === i.value.length; })()',
      ),
      true,
    );

    await setTheme(true);
    await screenshot("find-dark");
    await setTheme(false);

    window.webContents.insertText("zzz");
    await waitFor('document.querySelector("[data-find-count]").textContent === "No results"');
    assert.equal(await evaluate('CSS.highlights.has("find-match") ? CSS.highlights.get("find-match").size : 0'), 0);
    await evaluate('document.querySelector("[data-find-bar] input").select()');
    window.webContents.insertText("needle");
    await waitFor('document.querySelector("[data-find-count]").textContent === "1 of 5"');

    key("Escape");
    await waitFor('!document.querySelector("[data-find-bar]")');
    assert.equal(await evaluate("CSS.highlights.size"), 0);
    assert.equal(await evaluate('document.activeElement === document.querySelector("[data-prompt-editor]")'), true);
    console.log("PASS: opens with the shortcut, live count, Enter and Shift+Enter step and scroll, wrap, reopen selects, Esc clears and restores focus");
    await appPhase();
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
        name: "find-fixture",
        resolveId(id) {
          if (id.startsWith("/__find_")) return id;
        },
        load(id) {
          if (id === "/__find_fixture.tsx") return fixture;
          if (id === "/__find_app_fixture.tsx") return appFixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            const entry = { "/__find__": "/__find_fixture.tsx", "/__find_app__": "/__find_app_fixture.tsx" }[request.url];
            if (!entry) return next();
            const html = await server.transformIndexHtml(
              request.url,
              `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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
    const child = spawn(
      require("electron"),
      [path.resolve(__filename), `${server.resolvedUrls.local[0]}__find__`, `${server.resolvedUrls.local[0]}__find_app__`],
      { env, stdio: "inherit" },
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
  process.exitCode = 1;
});
