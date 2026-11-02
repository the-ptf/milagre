// Run with npm test -- --only test-allow-computer. The Allow prompt in the real App against a real daemon (its own
// temporary data directory and socket; the relay host is a stand-in that records its options): a computer pairing for
// the first time asks, Allow lets it in, Deny and Escape turn it away, one that gives up takes its prompt with it, and
// two at once are asked one after the other. Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { thisComputer } = require("@milagre/shared/host-computer");
const { openRenderer } = require("./renderer-ready.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
// The window talks to the host through the main process, as the real preload does (see electron/preload.cjs).
const { ipcRenderer } = window.require("electron");
const state = { next_id: 3, projects: { 1: { id: 1, name: "shop" } }, worktrees: { 1: { id: 1, name: "main", path: "/fixture", project_id: 1 } }, sessions: { 2: { id: 2, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle" } }, connections: {}, events: [], messages: [], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getCurrentProject: async () => ({ path: "/fixture", name: "shop", state }),
  listBranches: async () => ["main"],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: "idle" }),
  getAppVersion: async () => "0.0.0",
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  listPendingDevices: () => ipcRenderer.invoke("devices:pending"),
  allowDevice: (key) => ipcRenderer.invoke("devices:allow", key),
  denyDevice: (key) => ipcRenderer.invoke("devices:deny", key),
  onDevicesPending: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("devices:pending", listener);
    return () => ipcRenderer.removeListener("devices:pending", listener);
  },
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
localStorage.setItem("milagre-settings", JSON.stringify({ defaultModelId: "claude-opus-5-5", defaultPermissionMode: "ask" }));
const { default: App } = await import("/src/App");
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { startDaemon } = require("../apps/daemon/src/server.cjs");
  const { connect } = require("../apps/daemon/src/client.cjs");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-allow-ui-")));
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-allow-host-")));
  await app.whenReady();
  // The check never dials the public relay: this stand-in reports that it connected and keeps the options, whose
  // allowComputer is the real one phone access hands a relay host.
  const relays = [];
  const startRelay = (options) => {
    relays.push(options);
    setTimeout(() => options.onStatus?.("online"), 20);
    return { close: async () => {}, status: () => "online" };
  };
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    phoneOptions: { localPort: 0, lanPort: null, startRelay },
    runtimeOptions: {
      cwd: dataDir,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }),
    },
  });
  const host = await connect({ dataDir });
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    useContentSize: true,
    show: false,
    webPreferences: { partition: "allow-test", backgroundThrottling: false, nodeIntegration: true, contextIsolation: false },
  });
  for (const method of ["devices:pending", "devices:allow", "devices:deny"]) ipcMain.handle(method, (_event, ...args) => host.call(method, args));
  host.on("event", ({ channel, payload }) => {
    if (channel === "devices:pending" && !window.isDestroyed()) window.webContents.send(channel, payload);
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  const evaluate = async (source) => {
    try {
      return await window.webContents.executeJavaScript(source);
    } catch (error) {
      throw new Error(`${source}: ${error.message}`, { cause: error });
    }
  };
  async function waitFor(source) {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error(`Timed out: ${source}`);
  }
  const prompt = `document.querySelector('dialog[data-computer-allow]')`;
  const asking = (name) => `!!${prompt}?.open && ${prompt}.textContent.includes(${JSON.stringify(`${name} wants to drive ${thisComputer}'s chats`)})`;
  async function press(text) {
    const button = `[...${prompt}.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
    await waitFor(`!!(${button}) && !(${button}).disabled`);
    await evaluate(`(${button}).click()`);
  }
  /** A click as it lands, enabled or not (a disabled button takes none). */
  const clickNow = (text) =>
    evaluate(
      `(() => { const button = [...${prompt}.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(text)}); button?.click(); return !!button && !button.disabled; })()`,
    );
  const screenshotDir = process.env.MILAGRE_SCREENSHOT_DIR;
  async function screenshot(name) {
    if (!screenshotDir) return;
    await delay(400);
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  /** Asks as a computer's first hello does; `verdict` settles with the owner's answer. */
  function ask(key, name) {
    const abort = new AbortController();
    const verdict = relays.at(-1).allowComputer({ key, name, signal: abort.signal, waiting() {} });
    return { verdict, abort };
  }

  try {
    await openRenderer(window, process.argv[2], `!!document.querySelector('[aria-label="Settings"]')`);
    await host.call("phone:set-enabled", [true]);
    for (let n = 0; n < 200 && !relays.length; n++) await delay(25);
    assert.equal(relays.length, 1, "phone access started its relay host");
    assert.equal(await evaluate(`!!${prompt}?.open`), false, "nothing asks before a computer does");

    const studio = ask("s".repeat(43), "studio");
    await waitFor(asking("studio"));
    assert.match(await evaluate(`${prompt}.textContent`), /except pair and remove devices/);
    await screenshot("allow-prompt");
    await press("Allow");
    assert.equal(await studio.verdict, "allowed");
    await waitFor(`!${prompt}?.open`);
    console.log("PASS: a computer pairing for the first time asks, and Allow lets it in");

    const nameless = ask("n".repeat(43), null);
    await waitFor(asking("A computer"));
    await press("Deny");
    assert.equal(await nameless.verdict, "denied");
    const escaped = ask("e".repeat(43), "lab");
    await waitFor(asking("lab"));
    await evaluate(`${prompt}.dispatchEvent(new Event('cancel', { cancelable: true }))`);
    assert.equal(await escaped.verdict, "denied");
    await waitFor(`!${prompt}?.open`);
    console.log("PASS: Deny and Escape turn a computer away; one without a name is called a computer");

    const gone = ask("g".repeat(43), "gone");
    await waitFor(asking("gone"));
    gone.abort.abort();
    assert.equal(await gone.verdict, "dropped");
    await waitFor(`!${prompt}?.open`);
    console.log("PASS: a computer that gives up takes its prompt with it");

    const alpha = ask("a".repeat(43), "alpha");
    const beta = ask("b".repeat(43), "beta");
    await waitFor(asking("alpha"));
    await screenshot("allow-two-waiting");
    await press("Deny");
    await waitFor(asking("beta"));
    await press("Allow");
    assert.deepEqual(await Promise.all([alpha.verdict, beta.verdict]), ["denied", "allowed"]);
    await waitFor(`!${prompt}?.open`);
    assert.deepEqual(await host.call("devices:pending"), []);
    console.log("PASS: two computers at once are asked one after the other, oldest first");

    // The second click of a double-click lands as the next request replaces the first: it must not allow what was never read.
    const gamma = ask("c".repeat(43), "gamma");
    const delta = ask("d".repeat(43), "delta");
    await waitFor(asking("gamma"));
    await press("Allow");
    assert.equal(await gamma.verdict, "allowed");
    await waitFor(asking("delta"));
    const landed = await clickNow("Allow");
    assert.equal(landed, false, "the next request's Allow is not armed the moment it appears");
    await clickNow("Deny");
    const early = await Promise.race([delta.verdict, delay(300).then(() => "waiting")]);
    assert.equal(early, "waiting", "a click right after the request changed answers nothing");
    assert.equal((await host.call("devices:pending")).length, 1);
    await press("Allow");
    assert.equal(await delta.verdict, "allowed");
    await waitFor(`!${prompt}?.open`);
    console.log("PASS: the click that follows a request change is ignored, and Allow works once it is armed");

    host.close();
    await daemon.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (error.code !== "ERR_RENDERER_READINESS") await screenshot("failure").catch(() => {});
    host.close();
    // The daemon is in this Electron process; exit also bounds cleanup if its close stalls after a renderer failure.
    const exitTimer = error.code === "ERR_RENDERER_READINESS" ? setTimeout(() => app.exit(1), Math.max(0, error.failureDeadline - performance.now())) : null;
    await daemon.close().catch(() => {});
    clearTimeout(exitTimer);
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
        name: "allow-fixture",
        resolveId(id) {
          if (id === "/__allow_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__allow_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__allow__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__allow_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__allow__`], { env, stdio: "inherit" });
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
