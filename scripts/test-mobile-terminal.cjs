// Run with node scripts/test-mobile-terminal.cjs. Loads the phone's Terminal page (apps/mobile/src/terminal-receiver.ts)
// in Chromium, standing in for the WebView: its messages go to a real shell through the same follower the phone uses,
// and the host's output comes back through the page's window functions, each read waiting for the page's `wrote` as the
// phone's does. Checks typing, the held Ctrl, a flood read in limited pieces and the theme.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");

const preload = `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("ReactNativeWebView", { postMessage: (message) => ipcRenderer.send("terminal-view", message) });
`;

async function electronChecks() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { createTerminals, terminalEnvironment, terminalShell } = require("../packages/core/src/terminals.cjs");
  const { followTerminal } = await import(pathToFileURL(path.join(__dirname, "../packages/shared/src/terminal-client.mjs")).href);
  const [page, themesFile] = process.argv.slice(2);
  const themes = JSON.parse(fs.readFileSync(themesFile, "utf8"));
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mobile-terminal-")));
  app.setPath("userData", path.join(scratch, "profile"));
  const preloadFile = path.join(scratch, "preload.cjs");
  fs.writeFileSync(preloadFile, preload);
  await app.whenReady();
  const window = new BrowserWindow({ width: 390, height: 640, useContentSize: true, show: false, webPreferences: { preload: preloadFile, sandbox: false } });
  const selectedShell = process.platform === "linux" ? terminalShell() : { file: "/bin/sh", args: [] };
  // The disposable home has no profile yet; skip zsh's first-run configuration wizard.
  fs.writeFileSync(path.join(scratch, ".zshrc"), "# Terminal fixture\n");
  const terminals = createTerminals({
    resolveChat: async () => [{ path: scratch, label: "phone" }],
    shell: () => selectedShell,
    environment: () => terminalEnvironment({ PATH: "/usr/bin:/bin", HOME: scratch, PS1: "$ " }),
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const messages = [];
  let follower = null;
  const call = (script) => void window.webContents.executeJavaScript(`${script};true;`);
  // As the phone does it (apps/mobile/src/terminal.tsx): each write settles when the page answers `wrote` with its id.
  const unwritten = new Map();
  let writeId = 0;
  let reads = 0;
  const draw = (name, data) =>
    new Promise((resolve) => {
      const id = ++writeId;
      unwritten.set(id, resolve);
      call(`window.${name}(${JSON.stringify(data)},${id})`);
    });
  const opened = await terminals.open({ chatId: "/phone#1" });
  ipcMain.on("terminal-view", (_event, raw) => {
    const message = JSON.parse(raw);
    messages.push(message);
    if (message.channel !== "milagre-terminal") return;
    if (message.event === "ready") {
      follower = followTerminal({
        terminalId: opened.id,
        api: {
          read: (request) => {
            reads++;
            return terminals.read(request);
          },
          input: terminals.input,
          resize: terminals.resize,
        },
        write: (data) => draw("terminalWrite", data),
        reset: (data) => draw("terminalReset", data),
        readLimit: 64 * 1024,
      });
      follower.resize(message.cols, message.rows);
    } else if (message.event === "input") follower?.send(message.data);
    else if (message.event === "resize") follower?.resize(message.cols, message.rows);
    else if (message.event === "wrote") {
      unwritten.get(message.id)?.();
      unwritten.delete(message.id);
    }
  });
  const screenshotDir = process.env.MILAGRE_SCREENSHOT_DIR;
  async function screenshot(name) {
    if (!screenshotDir) return;
    await delay(300);
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(check, what) {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await check()) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${what}`);
  }
  const shown = () => evaluate('document.querySelector(".xterm-rows")?.textContent ?? ""');
  async function type(text) {
    for (const char of text) {
      if (char === "\r") {
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      } else {
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: char });
        window.webContents.sendInputEvent({ type: "char", keyCode: char });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: char });
      }
      await delay(5);
    }
  }
  try {
    await window.loadFile(page);
    await waitFor(() => messages.some((message) => message.event === "ready"), "the page's ready message");
    const ready = messages.find((message) => message.event === "ready");
    assert.ok(ready.cols >= 30 && ready.rows >= 20, `The page did not fit the phone's width: ${JSON.stringify(ready)}`);
    await waitFor(async () => (await terminals.list({ chatId: "/phone#1" })).terminals[0].cols === ready.cols, "the PTY sized to the page");
    window.webContents.focus();
    await evaluate("window.terminalFocus()");
    await type("echo phone-$((40+2))\r");
    await waitFor(async () => (await shown()).includes("phone-42"), "the command's output");
    if (path.basename(selectedShell.file) === "zsh") {
      await type("echo shell-name:$0\r");
      await waitFor(async () => /shell-name:[^\s]*zsh/.test(await shown()), "the selected shell is running zsh");
    }

    // A held Ctrl turns the next letter into its control character: Ctrl+C stops a running command.
    await type("sleep 30\r");
    await waitFor(async () => (await terminals.list({ chatId: "/phone#1" })).terminals[0].busy, "sleep running");
    await evaluate("window.terminalCtrl(true)");
    await type("c");
    await waitFor(() => messages.some((message) => message.event === "ctrl-used"), "the Ctrl key released after use");
    await waitFor(async () => !(await terminals.list({ chatId: "/phone#1" })).terminals[0].busy, "sleep stopped by Ctrl+C");
    await type("echo after-ctrl\r");
    await waitFor(async () => (await shown()).includes("after-ctrl"), "typing works after Ctrl");
    // A flood comes in limited reads, each after the page parsed the last, and the Terminal answers again after it.
    reads = 0;
    await type("seq 1 100000; echo flood-$((1+1))\r");
    await waitFor(async () => (await shown()).includes("flood-2"), "the end of a 600 KB flood");
    assert.ok(reads >= 6, `The flood came in ${reads} reads; 64 KB reads take at least 6`);
    assert.equal(unwritten.size, 0, "Every write was answered");
    await type("echo after-flood\r");
    await waitFor(async () => (await shown()).includes("after-flood"), "typing works after a flood");
    await screenshot("mobile-terminal-dark");
    await evaluate(`window.terminalTheme(${JSON.stringify(themes.light)})`);
    await screenshot("mobile-terminal-light");
    console.log("PASS: the phone's Terminal page fits the PTY, runs commands, Ctrl+C stops a command, a flood arrives in limited reads and the theme switches");
    follower?.stop();
    await terminals.dispose();
    app.exit(0);
  } catch (error) {
    console.error(error);
    follower?.stop();
    await terminals.dispose();
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const root = path.resolve(__dirname, "..");
  const server = await createServer({ configFile: false, root, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const receiver = await server.ssrLoadModule(path.join(root, "apps/mobile/src/terminal-receiver.ts"));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mobile-terminal-page-"));
    const page = path.join(scratch, "terminal.html");
    // The phone's Gray palettes, from the shared theme registry like apps/mobile/src/theme.ts.
    const { resolvePalette } = await server.ssrLoadModule(path.join(root, "packages/shared/src/themes/index.ts"));
    const terminalTheme = (scheme) => {
      const p = resolvePalette("gray", scheme);
      return { scheme, background: p.page, ink: p.ink, ink3: p.ink3, accent: p.accent, ansi: [...p.ansi], cursor: p.cursor, selection: p.selection };
    };
    const dark = terminalTheme("dark");
    const light = terminalTheme("light");
    fs.writeFileSync(page, receiver.createTerminalHtml(dark));
    const themes = path.join(scratch, "themes.json");
    fs.writeFileSync(themes, JSON.stringify({ light: receiver.xtermTheme(light) }));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), page, themes], { env, stdio: "inherit" });
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
