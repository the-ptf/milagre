// Real Electron rendering of the Browser panel's streamed pages against real headless Chrome pages, through the real core
// service. Needs Google Chrome (or MILAGRE_TEST_CHROME). Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const CHROME = process.env.MILAGRE_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE =
  "data:text/html," +
  encodeURIComponent(`<!doctype html><title>Fixture login</title><body style="margin:0;font:18px -apple-system,sans-serif;background:#fff3d6;color:#5a3b00">
<input id="name" placeholder="Name" style="position:absolute;left:20px;top:20px;width:320px;height:44px;font-size:20px">
<button id="go" onclick="document.title='Signed in'" style="position:absolute;left:20px;top:100px;width:200px;height:60px;font-size:18px">Sign in</button>
<p style="position:absolute;left:20px;top:190px">A page opened by the agent, with its own colors.</p><div style="height:4000px"></div>`);
const OTHER =
  "data:text/html," +
  encodeURIComponent(
    '<!doctype html><title>Someone else\'s tab</title><body style="margin:0;background:#dff3ff;font:20px sans-serif"><h1 style="margin:24px">Not started by this Chat</h1>',
  );

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { PanelToggles } from "/src/components/agents/PanelToggles";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const noop = () => {};
function Fixture() {
  const [draft, setDraft] = useState("");
  window.setDark = (dark) => document.documentElement.classList.toggle("dark", dark);
  const model = MODEL_CATALOG[0];
  const messages = [{ id: 1, session_id: 1, context: null, role: "user", body: "Sign in on the staging site." }];
  const children = [{ id: "review", title: "Check the form", status: "running", startedAt: Date.now() - 5000, updatedAt: Date.now(), transcript: [] }];
  return <div style={{ height: "100%", padding: 12 }}>
    <PanelToggles right={12} />
    <ChatComposer messages={messages} agentChatId="/fixture#1"
      imageDraft={{ images: [], files: [], attachFiles: noop, attachPath: noop, removeFile: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/fixture" draft={draft} onDraftChange={setDraft} onSend={noop} isSending={true} sendBlocked={false} tasks={[]} subagents={children} onArchiveFinishedSubagents={noop} onArchiveSubagent={noop} waitingForSubagents={false}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const PRELOAD = `
const { contextBridge, ipcRenderer } = require('electron');
const api = (prefix, names) => Object.fromEntries(names.map(name => [name, request => ipcRenderer.invoke(prefix + name, request)]));
contextBridge.exposeInMainWorld('milagre', {
  browsers: api('browser:', ['list', 'attach', 'detach', 'open', 'frame', 'status', 'control', 'input', 'close']),
  simulators: { list: async ({ chatId }) => ({ chatId, devices: [{ id: "sim-1", name: "iPhone 17", state: "Booted", runtime: "iOS 26" }], attached: [{ id: "sim-1", name: "iPhone 17", state: "Booted", runtime: "iOS 26" }], available: [], supported: true }) },
});`;

async function browserChecks(url) {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { createBrowsers } = require("../packages/core/src/browsers.cjs");
  const { createBrowserAdapter } = require("../packages/core/src/browsers-cdp.cjs");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-browser-ui-"));
  app.setPath("userData", path.join(temp, "electron"));
  const profiles = [path.join(temp, "agent-profile"), path.join(temp, "other-profile")];
  // The agent's browser descends from this process. The other one is started through a shell that exits, like a
  // browser the user opened themselves, so it has no lineage to any Chat.
  const agentChrome = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profiles[0]}`, "--no-first-run", "--window-size=800,600", PAGE],
    { stdio: "ignore", detached: true },
  );
  execFileSync("/bin/sh", [
    "-c",
    `"${CHROME}" --headless=new --remote-debugging-port=0 --user-data-dir="${profiles[1]}" --no-first-run --window-size=700,500 "${OTHER}" >/dev/null 2>&1 &`,
  ]);
  const stopChrome = () => {
    try {
      process.kill(-agentChrome.pid, "SIGTERM");
    } catch {}
    try {
      execFileSync("pkill", ["-f", `user-data-dir=${profiles[1]}`]);
    } catch {}
  };
  const service = createBrowsers({ roots: () => new Map([["/fixture#1", { pid: process.pid }]]) });
  const counts = { open: 0, close: 0 };
  ipcMain.handle("browser:list", (_event, request) => service.list(request));
  ipcMain.handle("browser:attach", (_event, request) => service.attach(request));
  ipcMain.handle("browser:detach", (_event, request) => service.detach(request));
  for (const method of ["open", "frame", "status", "control", "input", "close"])
    ipcMain.handle("browser:" + method, (_event, request) => {
      if (method in counts) counts[method]++;
      return service[method === "close" ? "closeViewer" : method](request, "desktop");
    });
  const adapter = createBrowserAdapter();
  // Reads page state over its own DevTools session, independent of the viewer.
  const pageEval = async (title, expression) => {
    const world = await adapter.discover();
    for (const browser of world.browsers)
      for (const page of browser.pages) {
        if (!page.title.includes(title)) continue;
        const socket = new WebSocket(`ws://127.0.0.1:${browser.port}/devtools/page/${page.id}`);
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve);
          socket.addEventListener("error", reject);
        });
        socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        const value = await new Promise((resolve) => {
          socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data).result?.result?.value));
        });
        socket.close();
        return value;
      }
    return undefined;
  };
  await app.whenReady();
  const watchdog = setTimeout(() => {
    console.error("Browser UI check timed out");
    stopChrome();
    app.exit(1);
  }, 120000);
  fs.writeFileSync(path.join(temp, "preload.cjs"), PRELOAD);
  const window = new BrowserWindow({
    width: 1100,
    height: 860,
    show: false,
    webPreferences: { backgroundThrottling: false, preload: path.join(temp, "preload.cjs") },
  });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const waitFor = async (source, label = source) => {
    for (let i = 0; i < 300; i++) {
      if (await evaluate(source)) return;
      await delay(50);
    }
    throw Error("Timed out: " + label);
  };
  const waitUntil = async (check, label) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await delay(50);
    }
    throw Error("Timed out: " + label);
  };
  const click = (selector) => evaluate("document.querySelector(" + JSON.stringify(selector) + ").click()");
  const inFrame = (expression) =>
    evaluate(`(()=>{const doc=document.querySelector("[data-slot=browser-frame]")?.contentDocument;return doc?(${expression}):undefined})()`);
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  // Window coordinates of a CSS pixel in the shown page.
  const pagePoint = async (x, y, viewportWidth) => {
    const box = await evaluate(
      '(()=>{const f=document.querySelector("[data-slot=browser-frame]");const r=f.getBoundingClientRect();const i=f.contentDocument.getElementById("frame").getBoundingClientRect();return {left:r.left+i.left,top:r.top+i.top,width:i.width}})()',
    );
    const scale = box.width / viewportWidth;
    return { x: Math.round(box.left + x * scale), y: Math.round(box.top + y * scale) };
  };
  const mouseClick = async (point) => {
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    await delay(300);
  };
  const footerMatches =
    '(()=>{const doc=document.querySelector("[data-slot=browser-frame]")?.contentDocument;return !!doc?.querySelector("footer") && getComputedStyle(doc.querySelector("footer")).backgroundColor===getComputedStyle(document.querySelector("[data-slot=browser-page]")).backgroundColor})()';
  const shownFrame = '!!document.querySelector("[data-slot=browser-frame]")?.contentDocument?.getElementById("frame")?.naturalWidth';
  const toggle = "[data-panel-toggle=browser]";
  const streamedTab = (text) => `[...document.querySelectorAll("[data-browser-target]")].find(node=>node.textContent.includes(${JSON.stringify(text)}))`;
  const selectedTab = (text) => `${streamedTab(text)}?.querySelector("[role=tab]")?.getAttribute("aria-selected")==="true"`;
  try {
    await window.loadURL(url);
    await waitFor(`!!document.querySelector("${toggle}")`, "Browser button with the agent's page");
    assert.equal(counts.open, 0, "the button and the list start no capture");
    assert.ok(!(await evaluate('document.querySelector("[data-slot=browser-track]")')), "no Browser pill");
    await screenshot("composer-light");

    await click(toggle);
    await waitFor(shownFrame, "the panel opens on the agent's page with a live frame");
    assert.equal(counts.open, 1);
    assert.equal(await evaluate('document.querySelectorAll("[data-browser-tab]").length'), 0, "no blank page is added for streamed pages");
    await waitFor(selectedTab("Fixture login"), "the agent's page is a selected tab, titled");
    assert.ok(
      (await evaluate('document.querySelector("[data-slot=browser-viewer-address]").textContent')).startsWith("data:text/html"),
      "the page's address shows",
    );
    await waitFor(footerMatches, "controls strip matches the panel");
    await waitFor(
      'document.querySelector("[data-slot=browser-frame]").contentDocument.getElementById("live").textContent==="You control this page"',
      "first viewer takes free control",
    );
    // The page lays out at the viewer's size, not its 800x600 window's.
    const stage = await inFrame('[doc.getElementById("stage").clientWidth, doc.getElementById("stage").clientHeight].map(Math.round).join("x")');
    await waitUntil(async () => (await pageEval("Fixture", "innerWidth + 'x' + innerHeight")) === stage, `the page takes the viewer's size ${stage}`);
    await waitFor(
      `(()=>{const doc=document.querySelector("[data-slot=browser-frame]").contentDocument;const s=doc.getElementById("stage"),f=doc.getElementById("frame");return Math.abs(f.clientWidth-s.clientWidth)<2&&Math.abs(f.clientHeight-s.clientHeight)<2})()`,
      "the frame fills the viewer with no letterbox",
    );
    await screenshot("viewer-light");

    const viewport = await pageEval("Fixture", "innerWidth");
    await mouseClick(await pagePoint(150, 40, viewport));
    await waitUntil(async () => (await pageEval("Fixture", "document.activeElement.id")) === "name", "click focuses the page input");
    for (const key of "milagre") {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
      window.webContents.sendInputEvent({ type: "char", keyCode: key });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
    }
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
    await waitUntil(async () => (await pageEval("Fixture", 'document.getElementById("name").value')) === "milagr", "typed text and Backspace reach the input");
    await mouseClick(await pagePoint(100, 130, viewport));
    await waitFor(selectedTab("Signed in"), "button click changes the page title shown on its tab");
    const wheelAt = await pagePoint(400, 300, viewport);
    window.webContents.sendInputEvent({ type: "mouseWheel", ...wheelAt, deltaX: 0, deltaY: -400 });
    await waitUntil(async () => (await pageEval("Signed in", "scrollY")) > 0, "wheel scrolls the page");
    await screenshot("viewer-after-input-light");

    await evaluate("window.setDark(true)");
    await waitFor(footerMatches, "dark controls strip matches the panel");
    assert.equal(counts.open, 1, "theme changes keep the same viewer");
    await screenshot("viewer-dark");

    // Another viewer takes control (as a phone would); this one becomes view-only and can take it back.
    const list = await service.list({ chatId: "/fixture#1" });
    const phone = await service.open({ chatId: "/fixture#1", targetId: list.targets[0].id }, "phone");
    await service.control({ viewerId: phone.viewerId, takeOver: true }, "phone");
    await waitFor(
      '(()=>{const c=document.querySelector("[data-slot=browser-frame]").contentDocument.getElementById("control");return c&&!c.hidden})()',
      "takeover shows Take control",
    );
    assert.equal(await inFrame('doc.getElementById("reload").disabled'), true, "view-only controls are disabled");
    await screenshot("view-only-dark");
    await inFrame('doc.getElementById("control").click()');
    await waitFor('document.querySelector("[data-slot=browser-frame]").contentDocument.getElementById("control").hidden', "Take control returns control");
    await service.closeViewer({ viewerId: phone.viewerId }, "phone");

    // A new page lists the other browser for an explicit attach.
    await click('[aria-label="New page"]');
    await waitFor('!!document.querySelector("[data-browser-other]")', "a blank page lists the other browser for explicit attach");
    await waitUntil(() => counts.close >= 1, "a page of its own on show ends the stream");
    assert.equal(await evaluate('document.querySelectorAll("[data-browser-target]").length'), 1, "the other browser is not shown as this Chat's page");
    await screenshot("start-page-dark");
    // Other CDP browsers on the machine (another Milagre, a dev Chrome) may be listed too: attach the fixture's one.
    await evaluate(
      '[...document.querySelectorAll("[data-browser-other]")].find(node=>node.textContent.includes("Someone else")).querySelector("button").click()',
    );
    await waitFor('document.querySelectorAll("[data-browser-target]").length===2', "attached browser joins this Chat");
    await waitFor(selectedTab("Someone else"), "the attached page shows");
    await waitFor(shownFrame, "attached page streams");
    await evaluate("window.setDark(false)");
    await waitFor(footerMatches);
    await screenshot("attached-light");

    // Hiding the panel ends Milagre's capture only; both browsers keep running.
    const closed = counts.close;
    await click('[aria-label="Hide Browser panel"]');
    await waitFor('!document.querySelector("[data-slot=browser-dock]")');
    await waitUntil(() => counts.close > closed, "viewer close reaches the host");
    process.kill(agentChrome.pid, 0);
    assert.ok((await pageEval("Someone else", "document.title")).includes("Someone else"), "the attached browser is still open");

    // A page that closes while viewed fails clearly and offers Retry.
    await click(toggle);
    await waitFor(selectedTab("Someone else"), "the panel opens where it was");
    await waitFor(shownFrame);
    const world = await adapter.discover();
    const other = world.browsers.find((browser) => browser.pages.some((page) => page.title.includes("Someone else")));
    await fetch(`http://127.0.0.1:${other.port}/json/close/${other.pages[0].id}`).catch(() => {});
    await waitFor(
      '(()=>{const doc=document.querySelector("[data-slot=browser-frame]").contentDocument;return !doc.getElementById("retry").hidden && /closed/.test(doc.getElementById("message").textContent)})()',
      "closed page shows its reason and Retry",
    );
    await screenshot("page-closed-light");

    // Detach ends only this Chat's attachment: the browser is offered again.
    await waitFor('!!document.querySelector("[data-browser-detach]")', "attached pages offer Detach");
    await click("[data-browser-detach]");
    await waitFor('document.querySelectorAll("[data-browser-target]").length===1', "detached browser leaves the tabs");
    assert.ok(!(await evaluate('document.querySelector("[data-browser-detach]")')), "the agent's own browser has no Detach");
    await click("[data-browser-tab] [role=tab]");
    await waitFor('!!document.querySelector("[data-browser-other]")', "detached browser is offered again");
    await screenshot("detached-light");

    // The last page of its own closing leaves the streamed one on show.
    await evaluate('document.querySelector("[data-browser-tab] [aria-label^=Close]").click()');
    await waitFor(`!document.querySelector("[data-browser-tab]") && ${selectedTab("Signed in")}`, "closing the blank page shows the agent's page");
    await waitFor(shownFrame);
    await click('[aria-label="Hide Browser panel"]');
    await waitFor('!document.querySelector("[data-slot=browser-dock]")');

    // No page in this Chat, no Browser button: an attachable browser alone does not promote it.
    process.kill(-agentChrome.pid, "SIGTERM");
    await waitUntil(async () => !(await service.list({ chatId: "/fixture#1" })).targets.length, "agent browser gone from the host");
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await waitFor(`!document.querySelector("${toggle}")`, "Browser button goes with the last page even though another browser is attachable");
    assert.ok((await service.list({ chatId: "/fixture#1" })).others.length >= 1, "the other browser is still attachable");
    await screenshot("no-page-light");
    clearTimeout(watchdog);
    console.log(
      "PASS: Browser button with a page, on-demand capture, panel opens on the streamed page, live frame at the viewer's size, tab title/address, click, typing, Backspace, wheel, live theme without reconnect, takeover and retake, attach from a blank page, hide keeps browsers running, closed-page failure, detach, last own tab closing keeps the stream, no button without a page",
    );
    await service.close();
    stopChrome();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure").catch(() => {});
    console.error("Visible text:", await evaluate('document.querySelector("[data-slot=browser-dock]")?.innerText').catch(() => ""));
    await service.close().catch(() => {});
    stopChrome();
    app.exit(1);
  }
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log("SKIP: Google Chrome not found. Set MILAGRE_TEST_CHROME.");
    return;
  }
  const { createServer } = await import("vite");
  const server = await createServer({
    root: path.join(__dirname, "../apps/desktop/app"),
    configFile: path.join(__dirname, "../apps/desktop/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "browser-fixture",
        resolveId(id) {
          if (id === "/__browsers_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__browsers_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (req, res, next) => {
            if (req.url !== "/__browsers__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                req.url,
                '<html><body><div id="root"></div><script type="module" src="/__browsers_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__browsers__"], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? browserChecks(process.argv.at(-1)) : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
