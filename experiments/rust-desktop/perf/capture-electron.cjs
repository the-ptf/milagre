// Real production renderer/preload, attached to the already-running host.
// This is a limited capture shell, not the installed Electron app or a performance baseline.
const { app, BrowserWindow, ipcMain, protocol, net } = require("electron");
const { parseArgs } = require("node:util");
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { homedir, tmpdir } = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const { createArtifactPreviews } = require("../../../apps/desktop/electron/artifact-preview.cjs");
const { createMediaHandler } = require("../../../apps/desktop/electron/media.cjs");
const { windowChrome } = require("../../../apps/desktop/electron/window-chrome.cjs");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    profile: { type: "string", default: join(homedir(), "Library/Application Support/Milagre") },
    plan: { type: "string" },
    output: { type: "string" },
    width: { type: "string", default: "1440" },
    height: { type: "string", default: "900" },
    "hold-seconds": { type: "string", default: "0" },
  },
});
if (process.env.MILAGRE_BACKGROUND !== "1") throw new Error("Set MILAGRE_BACKGROUND=1; this helper never shows an app window.");
if (!values.plan || !values.output) throw new Error("Provide --plan JSON_FILE and --output DIRECTORY outside the repository.");
const repo = resolve(__dirname, "../../..");
const output = resolve(values.output);
if (output === repo || output.startsWith(repo + "/")) throw new Error("Screenshots must remain outside Git.");
const plan = JSON.parse(readFileSync(values.plan, "utf8"));
if (!Array.isArray(plan) || !plan.length) throw new Error("Capture plan must be a nonempty array.");
for (const item of plan) {
  if (!/^[a-z0-9-]+$/.test(item.name) || typeof item.chatKey !== "string" || !["chat", "designs", "artifacts"].includes(item.panel)) {
    throw new Error("Each plan item needs name (a-z, 0-9, -), chatKey and panel (chat/designs/artifacts).");
  }
}
const width = Number(values.width);
const height = Number(values.height);
const holdSeconds = Number(values["hold-seconds"]);
if (!Number.isInteger(holdSeconds) || holdSeconds < 0 || holdSeconds > 1800) throw new Error("hold-seconds must be 0 to 1800.");
if (!Number.isInteger(width) || !Number.isInteger(height) || width < 980 || width > 3840 || height < 680 || height > 2160) throw new Error("Invalid viewport.");
mkdirSync(output, { recursive: true, mode: 0o700 });
const temporaryProfile = mkdtempSync(join(tmpdir(), "milagre-electron-capture-"));
app.setPath("userData", temporaryProfile);
app.setName("Milagre capture");
app.setActivationPolicy("accessory");
app.dock?.hide();
app.commandLine.appendSwitch("disable-background-timer-throttling");
protocol.registerSchemesAsPrivileged([
  { scheme: "milagre-artifact", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "milagre-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const preferences = JSON.parse(readFileSync(join(values.profile, "preferences.json"), "utf8"));
const calls = [];
const errors = [];
const captures = [];
let runtime;
let window;
let previews;
let daemon;
let selectedChatKey = null;
const memory = new Map();
// View reads and per-connection subscriptions only. No provider turns, terminals,
// project creation, edits, resets, deletion, sign-in, host ownership or host restart.
const readable = new Set([
  "agent:cli-status",
  "agent:models",
  "agent:ports",
  "agent:provider-updates",
  "artifact:list",
  "artifact:get",
  "artifact:asset",
  "artifact:comments",
  "artifact:sharing-status",
  "browser-comments:list",
  "browser:list",
  "canvas:links",
  "chat:messages",
  "chat:runs",
  "chat:set-open",
  "chats:home",
  "checkpoint:list",
  "computers:list",
  "computers:recall",
  "context:settings:read",
  "designs:enabled:read",
  "devices:pending",
  "done:settings:read",
  "keybindings:read",
  "linear:enabled:read",
  "linear:status",
  "link:list",
  "linked:snapshot",
  "pr:detail",
  "project:branches",
  "project:current",
  "project:image",
  "project:read",
  "project:recent",
  "project:registry",
  "pull-requests:snapshot",
  "routines:enabled:read",
  "routines:list",
  "skills:list",
  "simulator:list",
  "state:read",
  "terminal:list",
  "usage:cached",
  "usage:read",
]);
function allowed(method, args) {
  return readable.has(method) || (method === "computers:invoke" && typeof args[1] === "string" && readable.has(args[1]));
}
const native = {
  "app:host-ready": () => true,
  "app:version": () => app.getVersion(),
  "app:dictation-status": () => [],
  "app:set-keep-awake": () => false,
  "app:terminal-focused": () => false,
  "browser-panel:pages": () => [],
  "editor:list": () => [],
  "floating-inbox:selected": () => null,
  "floating-inbox:is-open": () => false,
  "runtime:connection": () => ({ connected: true }),
  "settings:floating-inbox": () => false,
  "settings:window-background": (_event, color) => window.setBackgroundColor(color),
  "settings:notify-when-waiting": () => false,
  "settings:notification-chime": () => false,
  "settings:notification-schedule": () => false,
  "notification:state": () => false,
  "notification:completed": () => false,
  "update:state": () => ({ status: "idle", version: null, progress: 0, auto: false }),
  "artifact-preview:register": (event, html, source) => previews.register(event.sender.id, html, source),
  "artifact-preview:release": (event, url) => previews.release(event.sender.id, url),
  // Selecting a Chat remembers the capture window's navigation only in memory.
  "computers:remember": (_event, id, entry) => memory.set(`${id}:${entry?.kind}`, entry),
};
function handle(method, handler) {
  ipcMain.handle(method, async (event, ...args) => {
    if (event.senderFrame !== window.webContents.mainFrame) throw new Error("Only the renderer's main frame can call the capture shell.");
    const call = { method, at: new Date().toISOString() };
    calls.push(call);
    try {
      return await handler(event, ...args);
    } catch (error) {
      call.error = error.message;
      throw error;
    }
  });
}
ipcMain.on("preferences:storage", (event, operation, key, value) => {
  if (event.senderFrame !== window.webContents.mainFrame || !/^milagre[.:-]/.test(key)) {
    event.returnValue = { error: "Invalid preference access" };
  } else if (operation === "get") event.returnValue = { value: preferences[key] };
  else if (operation === "set" && (typeof value === "string" || value === null)) {
    preferences[key] = value;
    event.returnValue = {};
  } else event.returnValue = { error: "Invalid preference operation" };
});

async function main() {
  // connectDesktopRuntime's connect-only mode cannot start, flush or stop a host.
  runtime = await connectDesktopRuntime({
    dataDir: values.profile,
    connect: async () => {
      const client = await connect({ dataDir: values.profile });
      try {
        client.status = await client.call("daemon:status", [{ computerManagement: true }]);
        return client;
      } catch (error) {
        client.close();
        throw error;
      }
    },
    emit: (channel, payload) => {
      if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
    },
  });
  daemon = await runtime.invoke("daemon:status");
  await app.whenReady();
  previews = createArtifactPreviews({ readAsset: (chatId, name, offset, length) => runtime.invoke("artifact:asset", [{ chatId, name, offset, length }]) });
  protocol.handle("milagre-artifact", (request) => previews.handle(request));
  protocol.handle(
    "milagre-media",
    createMediaHandler((url, options) => net.fetch(url, options)),
  );
  for (const [method, handler] of Object.entries(native)) handle(method, handler);
  for (const method of runtime.methods) {
    if (method in native) continue;
    handle(method, async (_event, ...args) => {
      if (!allowed(method, args)) throw new Error(`Capture shell refuses non-read command: ${method}`);
      const result = await runtime.invoke(method, args);
      if (method === "chat:set-open") selectedChatKey = args[0] ?? null;
      return result;
    });
  }
  window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    paintWhenInitiallyHidden: true,
    ...windowChrome(process.platform).options,
    backgroundColor: "#F5F3EF",
    webPreferences: {
      preload: join(repo, "apps/desktop/electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      additionalArguments: ["--milagre-window-controls=leading", "--milagre-opened-projects-before=1"],
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("console-message", (_event, details) => {
    if (details.level === "error") errors.push({ message: details.message, source: details.sourceId, line: details.lineNumber });
  });
  await window.loadFile(join(repo, "apps/desktop/dist/index.html"));
  await delay(10000);
  const prepare = readFileSync(join(__dirname, "prepare-capture.js"), "utf8");
  for (const item of plan) {
    window.webContents.send("notification:open-chat", item.chatKey);
    for (let index = 0; index < 150 && selectedChatKey !== item.chatKey; index++) await delay(100);
    if (selectedChatKey !== item.chatKey) throw new Error(`Renderer did not select requested saved Chat: ${item.chatKey}`);
    await delay(2000);
    const state = await window.webContents.executeJavaScript(`window.__comparisonCapture = ${JSON.stringify(item)};\n${prepare}`);
    const image = await window.webContents.capturePage();
    const file = join(output, `electron-${item.name}.png`);
    writeFileSync(file, image.toPNG(), { mode: 0o600 });
    captures.push({ ...item, selectedChatKey, file, pixelSize: image.getSize(), state });
  }
  if (holdSeconds) {
    writeReport("holding");
    await delay(holdSeconds * 1000);
  }
}
function writeReport(stage) {
  writeFileSync(
    join(output, "electron-capture.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        stage,
        holdSeconds,
        at: new Date().toISOString(),
        provenance:
          "Production React renderer and Electron preload from this checkout, limited background capture shell, existing real daemon. No fixture data or providers.",
        limitations: [
          "Limited renderer shell, not the installed Electron main process; full-app performance cannot be inferred.",
          "Content-area capture omits native titlebar controls.",
          "Native updates, editors, dictation and notification services are disabled in this limited shell.",
          "Only local saved Chats are supported for artifact assets.",
        ],
        pid: process.pid,
        electronVersion: process.versions.electron,
        daemonPid: daemon?.pid,
        viewport: { width, height },
        captures,
        calls,
        errors,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
main()
  .catch((error) => {
    errors.push({ message: error.message, stack: error.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    writeReport("closed");
    await runtime?.close();
    if (window && !window.isDestroyed()) window.destroy();
    try {
      rmSync(temporaryProfile, { recursive: true, force: true });
    } catch {
      /* Only this task's temporary Chromium profile. */
    }
    app.exit(process.exitCode || 0);
  });
