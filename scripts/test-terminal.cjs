// Run with node scripts/test-terminal.cjs. Drives the Terminal panel in Electron against real shells: ⌘J opens the
// first Terminal in the Chat's Worktree, typing runs commands, + adds a tab, ⌘W asks before ending a busy Terminal
// and ends an idle one, and `exit` closes the last tab and the panel.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const CHAT = "/fixture#1";
// ⌘ on macOS, Ctrl elsewhere: the main process only takes the close key with the platform's own modifier.
const COMMAND = process.platform === "darwin" ? "meta" : "control";

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import { TerminalPanel } from "/src/components/terminal/TerminalPanel";
import { PanelToggles } from "/src/components/agents/PanelToggles";
import { useTerminalSync } from "/src/lib/terminal-actions";
import "/src/styles.css";
import { Terminal } from "@xterm/xterm";
window.notices = [];
// The shown Terminal draws on a WebGL canvas, so its text is read from xterm's buffer, not the DOM.
const opened = [];
const open = Terminal.prototype.open;
Terminal.prototype.open = function (element) {
  opened.push(this);
  return open.call(this, element);
};
window.terminalText = () => {
  const term = opened.find((candidate) => candidate.element?.closest("[data-terminal-body]"));
  if (!term) return "";
  const lines = [];
  for (let row = 0; row < term.buffer.active.length; row++) lines.push(term.buffer.active.getLine(row)?.translateToString(true) ?? "");
  return lines.join("\\n");
};
window.terminalGpu = () => !!document.querySelector("[data-terminal-body] .xterm canvas");
window.setDark = (dark) => document.documentElement.classList.toggle("dark", dark);
const noop = () => {};
const messages = [
  { id: 1, session_id: 1, context: null, role: "user", body: "Start the dev server and check the logs." },
  { id: 2, session_id: 1, context: null, role: "assistant", body: "Open a Terminal with ⌘T and run npm run dev; the output stays there." },
];
function Fixture() {
  useTerminalSync(${JSON.stringify(CHAT)});
  const [model] = useState(MODEL_CATALOG[0]);
  const [places, setPlaces] = useState();
  window.setPlaces = setPlaces;
  // The chat pane as App lays it out: the Chat, then its Terminals, in one column.
  return <div data-chat-pane style={{ display: "flex", flexDirection: "column", height: "100vh", padding: 12, paddingTop: 48, boxSizing: "border-box", overflow: "hidden" }}>
    <ChatComposer messages={messages}
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={false} sendBlocked={false} subagents={[]}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
    <TerminalPanel chatId={${JSON.stringify(CHAT)}} places={places} notify={(message) => window.notices.push(message)} />
    <PanelToggles right={12} />
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const preload = `
const { contextBridge, ipcRenderer } = require("electron");
const call = (method) => (request) => ipcRenderer.invoke(method, request);
contextBridge.exposeInMainWorld("milagre", {
  terminals: { profiles: call("terminal:profiles"), setShell: call("terminal:setShell"), list: call("terminal:list"), open: call("terminal:open"), read: call("terminal:read"), input: call("terminal:input"), resize: call("terminal:resize"), close: call("terminal:close") },
  onTerminalsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:changed", listener);
    return () => ipcRenderer.removeListener("terminal:changed", listener);
  },
  setTerminalFocused: (focused) => ipcRenderer.send("app:terminal-focused", focused === true),
  onCloseFocusedTerminal: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app:close-focused-terminal", listener);
    return () => ipcRenderer.removeListener("app:close-focused-terminal", listener);
  },
});
`;

async function electronChecks() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { createTerminals, terminalEnvironment, terminalShell } = require("../packages/core/src/terminals.cjs");
  const { forwardAppShortcuts } = require("../apps/desktop/electron/app-shortcuts.cjs");
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-terminal-ui-")));
  const worktree = path.join(scratch, "dev-server");
  fs.mkdirSync(worktree);
  app.setPath("userData", path.join(scratch, "profile"));
  const preloadFile = path.join(scratch, "preload.cjs");
  fs.writeFileSync(preloadFile, preload);
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1000,
    height: 620,
    useContentSize: true,
    show: false,
    webPreferences: { preload: preloadFile, backgroundThrottling: false, sandbox: false },
  });
  const selectedShell = process.platform === "linux" ? terminalShell() : { file: "/bin/sh", args: [] };
  // The disposable home has no profile yet; skip zsh's first-run configuration wizard.
  fs.writeFileSync(path.join(scratch, ".zshrc"), "# Terminal fixture\n");
  const terminals = createTerminals({
    resolveChat: async (chatId) => {
      if (chatId !== CHAT) throw new Error("Unknown Chat");
      return [
        { path: worktree, label: "dev-server" },
        { path: scratch, label: "website" },
      ];
    },
    shell: () => selectedShell,
    settingsFile: path.join(scratch, "terminal-settings.json"),
    environment: () => terminalEnvironment({ PATH: "/usr/bin:/bin", HOME: scratch, PS1: "$ ", LANG: "en_US.UTF-8" }),
    onChange: (chatId) => !window.isDestroyed() && window.webContents.send("terminal:changed", { chatId }),
  });
  let resizes = [];
  for (const method of ["profiles", "setShell", "list", "open", "read", "input", "resize", "close"])
    ipcMain.handle(`terminal:${method}`, (_event, request) => {
      if (method === "resize") resizes.push(`${request.cols}x${request.rows}`);
      return terminals[method](request);
    });
  forwardAppShortcuts(window.webContents);
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
  const { evaluatePanel, waitForPanel } = require("./panel-menu-test.cjs").panelMenuHelpers(evaluate);
  const screenshotDir = process.env.MILAGRE_SCREENSHOT_DIR;
  async function screenshot(name) {
    if (!screenshotDir) return;
    await delay(300);
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  // A frame as it is now, mid-animation, without the settling delay.
  async function frame(name) {
    if (!screenshotDir) return;
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source, what = source) {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${what}`);
  }
  const shown = "window.terminalText()";
  const tabs = '[...document.querySelectorAll("[data-terminal-tab]")].map((tab) => tab.textContent)';
  function press(key, modifiers = []) {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
  }
  async function type(text) {
    for (const char of text) {
      if (char === "\r") press("Return");
      else {
        // As a real key press: xterm reads printable keys from the keypress that follows their keydown.
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: char });
        window.webContents.sendInputEvent({ type: "char", keyCode: char });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: char });
      }
      await delay(5);
    }
  }
  try {
    await window.loadURL(process.argv[2]);
    if (screenshotDir) window.showInactive();
    await waitForPanel('!!document.querySelector("[data-panel-toggle=terminal]")', "the Terminals corner button");
    assert.equal(await evaluate('!!document.querySelector("[data-terminal-panel]")'), false, "The panel starts hidden");
    window.webContents.focus();

    // ⌘J with no Terminal opens the first one, focused, in the Chat's Worktree.
    press("J", ["meta"]);
    await waitFor('!!document.querySelector("[data-terminal-panel] .xterm")', "the first Terminal");
    await waitFor('document.activeElement?.classList.contains("xterm-helper-textarea")', "focus in the Terminal");
    // The panel rises as it opens; once it has, the Chat has made room: its prompt sits above the panel, not under it.
    await waitFor('!!document.querySelector("[data-terminal-slot]:not([data-sliding])")', "the panel to finish opening");
    const layout = await evaluate(
      '(() => { const prompt = document.querySelector("[data-prompt-editor]").getBoundingClientRect(); const panel = document.querySelector("[data-terminal-panel]").getBoundingClientRect(); return { promptBottom: prompt.bottom, panelTop: panel.top, panelBottom: panel.bottom, height: innerHeight }; })()',
    );
    assert.ok(layout.promptBottom <= layout.panelTop && layout.panelBottom <= layout.height, `The prompt is under the Terminals: ${JSON.stringify(layout)}`);
    // WebGL where the GPU offers WebGL2; where it doesn't (CI's Linux blocklists it), the DOM renderer draws instead.
    const webgl2 = await evaluate('!!document.createElement("canvas").getContext("webgl2")');
    assert.equal(await evaluate("window.terminalGpu()"), webgl2, webgl2 ? "The shown Terminal draws with WebGL" : "The Terminal fell back to the DOM renderer");
    await type("echo milagre-$((40+2)); pwd\r");
    await waitFor(`${shown}.includes("milagre-42") && ${shown}.includes(${JSON.stringify(worktree)})`, "the command's output and the Worktree folder");
    if (path.basename(selectedShell.file) === "zsh") {
      await type("echo shell-name:$0\r");
      await waitFor(`/shell-name:[^\\s]*zsh/.test(${shown})`, "the selected shell is running zsh");
    }
    assert.equal(await evaluatePanel('document.querySelector("[data-panel-toggle=terminal]").getAttribute("aria-checked")'), "true");
    await type("printf '\\033[32mgreen\\033[0m \\033[1;34mblue\\033[0m\\n'\r");
    await waitFor(`${shown}.includes("green blue")`);
    await screenshot("terminal-dark");
    await evaluate("window.setDark(false)");
    await screenshot("terminal-light");
    await evaluate("window.setDark(true)");

    // A flood is read only as fast as xterm parses it, and the Terminal answers again once it is over.
    await type("seq 1 300000; echo flood-$((1+1))\r");
    await waitFor(`${shown}.includes("flood-2")`, "the end of a 2 MB flood");
    await type("echo after-$((2+2))\r");
    await waitFor(`${shown}.includes("after-4")`, "output after the flood");

    // The PTY takes the panel's size.
    const [{ cols, rows }] = (await terminals.list({ chatId: CHAT })).terminals;
    assert.ok(cols > 80 && rows >= 8, `The PTY was not fitted to the panel: ${cols}x${rows}`);

    // ⌘J hides the panel without ending the shell; ⌘J again brings it back with its output.
    // It falls as it hides and rises as it shows, showing its output all the way: the card keeps its size while the slot
    // moves, so the Terminal isn't refitted, nor the shell resized, on every frame.
    resizes = [];
    press("J", ["meta"]);
    await waitFor('!!document.querySelector("[data-terminal-slot][data-sliding]")', "the panel to start falling");
    await delay(60);
    await frame("terminal-closing");
    await waitFor('!document.querySelector("[data-terminal-panel]")', "the panel hidden");
    assert.equal((await terminals.list({ chatId: CHAT })).terminals.length, 1, "Hiding keeps the Terminal");
    press("J", ["meta"]);
    await waitFor('!!document.querySelector("[data-terminal-slot][data-sliding]")', "the panel to start rising");
    await delay(60);
    await frame("terminal-opening");
    assert.ok(await evaluate(`${shown}.includes("after-4")`), "The output shows while the panel rises");
    await waitFor('!!document.querySelector("[data-terminal-slot]:not([data-sliding])")', "the panel to finish opening");
    await waitFor(`${shown}.includes("after-4")`, "the same output after showing it again");
    assert.deepEqual(new Set(resizes), new Set([`${cols}x${rows}`]), `The PTY took other sizes as the panel moved: ${resizes}`);

    // Dragging the divider refits the Terminal as it goes, but the PTY learns only the size it was dropped at.
    resizes = [];
    await evaluate(`(() => {
      const handle = document.querySelector("[aria-label='Resize Terminals']").getBoundingClientRect();
      const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
      document.querySelector("[aria-label='Resize Terminals']").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      window.milagreDrag = { x, y };
    })()`);
    for (let step = 1; step <= 12; step++) {
      await evaluate(`window.dispatchEvent(new PointerEvent("pointermove", { clientX: milagreDrag.x, clientY: milagreDrag.y - ${step * 8} }))`);
      await delay(16);
    }
    await evaluate(`window.dispatchEvent(new PointerEvent("pointerup", { clientX: milagreDrag.x, clientY: milagreDrag.y - 96 }))`);
    await waitFor('document.querySelector("[data-terminal-panel]").getBoundingClientRect().height > 300', "the panel taller after the drag");
    const grown = async () => (await terminals.list({ chatId: CHAT })).terminals[0].rows > rows;
    for (let attempt = 0; attempt < 200 && !(await grown()); attempt++) await delay(25);
    // Long enough for any resize still on its way to arrive and be counted.
    await delay(300);
    const dropped = (await terminals.list({ chatId: CHAT })).terminals[0];
    const panelHeight = await evaluate('document.querySelector("[data-terminal-panel]").getBoundingClientRect().height');
    assert.ok(dropped.rows > rows, `The drag didn't grow the PTY: ${rows} -> ${dropped.rows} rows, panel ${panelHeight}px, sent ${resizes}`);
    assert.deepEqual(resizes, [`${dropped.cols}x${dropped.rows}`], "The PTY was resized once, at the drop");
    assert.equal((await evaluate('localStorage.getItem("milagre.terminal.height")')) !== null, true, "The dropped height is kept");

    // Choosing bash leaves the existing Terminal alone and applies to the next tab.
    const bash = (await terminals.profiles()).shells.find((item) => item.label === "bash");
    if (bash) {
      const existingId = (await terminals.list({ chatId: CHAT })).terminals[0].id;
      await waitFor('!!document.querySelector("[aria-label=\\"Shell for new Terminals\\"]")', "the shell selector");
      await evaluate('document.querySelector("[aria-label=\\"Shell for new Terminals\\"]").click()');
      await waitFor('!!document.querySelector("[role=listbox]")', "available shells");
      await screenshot("terminal-shell-options");
      await evaluate('[...document.querySelectorAll("[role=option]")].find((row) => row.textContent.startsWith("bash")).click()');
      await waitFor('document.querySelector("[aria-label=\\"Shell for new Terminals\\"]").textContent.includes("bash")', "saved bash selection");
      assert.equal((await terminals.profiles()).selectedShell, bash.file);
      assert.equal((await terminals.list({ chatId: CHAT })).terminals[0].id, existingId, "Choosing a shell keeps the existing Terminal");
    }
    // + adds a second tab; a running command makes it busy, and ⌘W asks before ending it.
    await evaluate("document.querySelector(\"[aria-label='New Terminal']\").click()");
    await waitFor(`${tabs}.length === 2`, "a second tab");
    await waitFor('document.activeElement?.classList.contains("xterm-helper-textarea")');
    if (bash) {
      await type("echo shell-name:$0\r");
      await waitFor(`/shell-name:[^\\s]*bash/.test(${shown})`, "the selected bash shell runs in the new Terminal");
      await screenshot("terminal-selected-bash");
    }
    await type("sleep 30\r");
    await waitFor(`${tabs}[1].includes("sleep")`, "the tab named after its command");
    press("W", [COMMAND]);
    await waitFor(`[...document.querySelectorAll("button")].some((button) => button.textContent === "End sleep")`, "the confirmation");
    assert.equal((await terminals.list({ chatId: CHAT })).terminals.length, 2, "⌘W asks first");
    await screenshot("terminal-confirm-dark");
    // A second ⌘W confirms: focus stayed in the Terminal.
    assert.equal(await evaluate('document.activeElement?.classList.contains("xterm-helper-textarea")'), true);
    press("W", [COMMAND]);
    await waitFor(`${tabs}.length === 1`, "the busy Terminal ended");
    assert.equal((await terminals.list({ chatId: CHAT })).terminals.length, 1);

    // exit ends the last Terminal: its tab and the panel go.
    await evaluate('document.querySelector("[data-terminal-tab]").click()');
    await waitFor('document.activeElement?.classList.contains("xterm-helper-textarea")');
    await type("exit\r");
    await waitFor('!document.querySelector("[data-terminal-panel]")', "the panel closed after exit");
    assert.deepEqual((await terminals.list({ chatId: CHAT })).terminals, []);
    // A linked Chat must keep its Worktree picker open while the empty panel rises.
    await evaluate(
      `window.setPlaces(${JSON.stringify([
        { path: worktree, label: "dev-server" },
        { path: scratch, label: "website" },
      ])})`,
    );
    await delay(300);
    press("J", ["meta"]);
    await waitFor('!!document.querySelector("[data-terminal-slot]:not([data-sliding])")', "the linked Chat picker to finish opening");
    await waitFor('document.querySelectorAll("[data-picker-row]").length === 2', "the linked Worktree choices");
    press("Return");
    await waitFor('!!document.querySelector("[data-terminal-panel] .xterm")', "a Terminal in the chosen linked Worktree");
    await type("pwd\r");
    await waitFor(`${shown}.includes(${JSON.stringify(worktree)})`, "the chosen linked Worktree folder");
    await evaluate('document.querySelector("[aria-label=\\"New Terminal\\"]").click()');
    await waitFor('document.querySelectorAll("[data-picker-row]").length === 2', "the next Terminal's Worktree choices");
    await evaluate('document.querySelectorAll("[data-picker-row]")[1].click()');
    await waitFor(`${tabs}.length === 2`, "a Terminal in the second linked Worktree");
    assert.equal((await terminals.list({ chatId: CHAT })).terminals[1].cwd, scratch);
    await evaluate('document.querySelector("[aria-label=\\"New Terminal\\"]").click()');
    await waitFor('!!document.querySelector("[data-picker-panel]")', "the Worktree picker again");
    await waitFor('document.activeElement?.hasAttribute("data-picker-row")', "keyboard focus in the picker");
    press("Escape");
    await waitFor('!document.querySelector("[data-picker-panel]")', "Escape to dismiss the picker");
    assert.equal((await terminals.list({ chatId: CHAT })).terminals.length, 2);
    assert.deepEqual(await evaluate("window.notices"), []);
    console.log(
      "PASS: Terminal commands, sizing, tabs and closing; linked Worktree picker survives opening, supports keyboard and click choices, and dismisses with Escape",
    );
    await terminals.dispose();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await terminals.dispose();
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
        name: "terminal-fixture",
        resolveId(id) {
          if (id === "/__terminal_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__terminal_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__terminal__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__terminal_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__terminal__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}

(process.versions.electron ? electronChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
