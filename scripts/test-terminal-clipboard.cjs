// Run with node scripts/test-terminal-clipboard.cjs. Drives a real Windows shell in the Terminal panel: Ctrl+C copies a
// selection and interrupts without one, Ctrl+V pastes, and a right click opens Copy and Paste. Windows only: test-terminal.cjs
// covers the panel on POSIX shells. The window shows, as the clipboard only answers a focused page; the clipboard is put back.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const CHAT = "/fixture#1";

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { TerminalPanel } from "/src/components/terminal/TerminalPanel";
import { PanelToggles } from "/src/components/agents/PanelToggles";
import { useTerminalSync } from "/src/lib/terminal-actions";
import "/src/styles.css";
import { Terminal } from "@xterm/xterm";
const opened = [];
const open = Terminal.prototype.open;
Terminal.prototype.open = function (element) {
  opened.push(this);
  return open.call(this, element);
};
const shownTerminal = () => opened.find((candidate) => candidate.element?.closest("[data-terminal-body]"));
window.terminalText = () => {
  const term = shownTerminal();
  if (!term) return "";
  const lines = [];
  for (let row = 0; row < term.buffer.active.length; row++) lines.push(term.buffer.active.getLine(row)?.translateToString(true) ?? "");
  return lines.join("\\n");
};
window.selectAll = () => shownTerminal().selectAll();
window.selection = () => shownTerminal().getSelection();
function Fixture() {
  useTerminalSync(${JSON.stringify(CHAT)});
  return <div data-chat-pane style={{ display: "flex", flexDirection: "column", height: "100vh", padding: 12, paddingTop: 48, boxSizing: "border-box", overflow: "hidden" }}>
    <div style={{ flex: 1 }} />
    <TerminalPanel chatId={${JSON.stringify(CHAT)}} notify={() => {}} />
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
  setTerminalFocused: () => {},
  onCloseFocusedTerminal: () => () => {},
});
`;

async function electronChecks() {
  const { app, BrowserWindow, clipboard, ipcMain } = require("electron");
  const { createTerminals, terminalEnvironment } = require("../packages/core/src/terminals.cjs");
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-terminal-clipboard-")));
  app.setPath("userData", path.join(scratch, "profile"));
  const preloadFile = path.join(scratch, "preload.cjs");
  fs.writeFileSync(preloadFile, preload);
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1000,
    height: 620,
    useContentSize: true,
    webPreferences: { preload: preloadFile, backgroundThrottling: false, sandbox: false },
  });
  const shell = { file: process.env.ComSpec, args: [] };
  assert.ok(shell.file, "A check of cmd.exe needs ComSpec");
  const terminals = createTerminals({
    resolveChat: async (chatId) => {
      if (chatId !== CHAT) throw new Error("Unknown Chat");
      return [{ path: scratch, label: "scratch" }];
    },
    shell: () => shell,
    settingsFile: path.join(scratch, "terminal-settings.json"),
    environment: () => terminalEnvironment(process.env),
    onChange: (chatId) => !window.isDestroyed() && window.webContents.send("terminal:changed", { chatId }),
  });
  for (const method of ["profiles", "setShell", "list", "open", "read", "input", "resize", "close"])
    ipcMain.handle(`terminal:${method}`, (_event, request) => terminals[method](request));
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(check, what) {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await check()) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${what}`);
  }
  const shown = () => evaluate("window.terminalText()");
  const showsText = (text) => waitFor(async () => (await shown()).includes(text), `"${text}" in the Terminal`);
  function press(key, modifiers = []) {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
  }
  async function type(text) {
    for (const char of text) {
      if (char === "\r") press("Return");
      else {
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: char });
        window.webContents.sendInputEvent({ type: "char", keyCode: char });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: char });
      }
      await delay(5);
    }
  }
  async function rightClick() {
    const point = await evaluate(
      '(() => { const box = document.querySelector("[data-terminal-body]").getBoundingClientRect(); return { x: Math.round(box.x + 80), y: Math.round(box.y + 40) }; })()',
    );
    window.webContents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...point });
    await waitFor(() => evaluate('!!document.querySelector("[data-terminal-menu]")'), "the Terminal menu");
  }
  const row = (label) =>
    `[...document.querySelectorAll("[data-terminal-menu] [role=menuitem]")].find((item) => item.textContent.startsWith(${JSON.stringify(label)}))`;
  const saved = await clipboard.readText();
  try {
    await window.loadURL(process.argv[2]);
    window.focus();
    window.webContents.focus();
    await waitFor(() => evaluate('!!document.querySelector("[data-panel-toggle=terminal]")'), "the Terminals button");
    await evaluate('document.querySelector("[data-panel-toggle=terminal]").click()');
    await waitFor(() => evaluate('document.activeElement?.classList.contains("xterm-helper-textarea")'), "focus in the Terminal");
    await type("echo clip-value\r");
    await showsText("clip-value");

    // Ctrl+C copies a selection and leaves the shell alone, and clears it so the next one interrupts.
    await clipboard.writeText("");
    await evaluate("window.selectAll()");
    press("C", ["control"]);
    await waitFor(async () => (await clipboard.readText()).includes("clip-value"), "Ctrl+C on the clipboard");
    assert.equal(await evaluate("window.selection()"), "", "Copying clears the selection");
    assert.ok(!(await shown()).includes("^C"), "Copying sends no interrupt");

    // Without a selection, Ctrl+C interrupts: a 60-second ping ends and the next command runs at once.
    await type("ping -n 60 127.0.0.1\r");
    await delay(1500);
    press("C", ["control"]);
    await type("echo after-interrupt\r");
    await showsText("after-interrupt");

    // Ctrl+V pastes the clipboard at the prompt.
    await clipboard.writeText("echo pasted-value");
    press("V", ["control"]);
    await showsText("echo pasted-value");
    press("Return");
    await waitFor(async () => (await shown()).split("pasted-value").length >= 3, "the pasted command's output");

    // Right click with a selection: Copy works, and the menu closes.
    await clipboard.writeText("");
    await evaluate("window.selectAll()");
    await rightClick();
    assert.equal(await evaluate(`${row("Copy")}.disabled`), false, "Copy is on with a selection");
    assert.match(await evaluate(`${row("Copy")}.textContent`), /Ctrl\+C/);
    await evaluate(`${row("Copy")}.click()`);
    await waitFor(async () => (await clipboard.readText()).includes("pasted-value"), "the menu's Copy on the clipboard");
    await waitFor(() => evaluate('!document.querySelector("[data-terminal-menu]")'), "the menu to close");
    assert.equal(await evaluate('document.activeElement?.classList.contains("xterm-helper-textarea")'), true, "Focus returns to the Terminal");

    // Right click with nothing selected: Copy is off, Paste works.
    await clipboard.writeText("echo menu-paste");
    await rightClick();
    assert.equal(await evaluate(`${row("Copy")}.disabled`), true, "Copy is off without a selection");
    await evaluate(`${row("Paste")}.click()`);
    await showsText("echo menu-paste");

    // A press outside closes the menu without pasting or copying.
    await rightClick();
    await evaluate('document.querySelector("[data-terminal-menu]") && document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))');
    await waitFor(() => evaluate('!document.querySelector("[data-terminal-menu]")'), "the menu to close on a press outside");

    console.log("PASS: Windows Terminal clipboard: Ctrl+C copies or interrupts, Ctrl+V pastes, right click copies and pastes");
    await clipboard.writeText(saved);
    await terminals.dispose();
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await shown().catch(() => ""));
    await clipboard.writeText(saved);
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
        name: "terminal-clipboard-fixture",
        resolveId(id) {
          if (id === "/__terminal_clipboard.tsx") return id;
        },
        load(id) {
          if (id === "/__terminal_clipboard.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__terminal_clipboard__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__terminal_clipboard.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__terminal_clipboard__`], { env, stdio: "inherit" });
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
