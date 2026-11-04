// Real Electron pages load independently from the discovered browser, through the real core
// service. Needs Google Chrome (or MILAGRE_TEST_CHROME). Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { pagePinsScript } = require("@milagre/shared/page-picker");

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
import { BrowserPages } from "/src/components/agents/BrowserPanel";
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
    <BrowserPages /><PanelToggles right={12} />
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-browser-ui-"));
  app.setPath("userData", path.join(temp, "electron"));
  const site = require("node:http").createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(decodeURIComponent((req.url === "/other" ? OTHER : PAGE).split(",").slice(1).join(",")));
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const profiles = [path.join(temp, "agent-profile"), path.join(temp, "other-profile")];
  // The agent's browser descends from this process. The other one is started through a shell that exits, like a
  // browser the user opened themselves, so it has no lineage to any Chat.
  const agentChrome = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profiles[0]}`, "--no-first-run", "--window-size=800,600", origin],
    { stdio: "ignore", detached: true },
  );
  execFileSync("/bin/sh", [
    "-c",
    `"${CHROME}" --headless=new --remote-debugging-port=0 --user-data-dir="${profiles[1]}" --no-first-run --window-size=700,500 "${origin}/other" >/dev/null 2>&1 &`,
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
  ipcMain.handle("browser:list", async (_event, request) => {
    const list = await service.list(request);
    // Discovery includes internal tabs. A blank first result must not hide the usable page after it.
    return { ...list, targets: [{ id: "blank-first", url: "about:blank", title: "New tab", browser: "Chrome", source: "agent" }, ...list.targets] };
  });
  ipcMain.handle("browser:attach", (_event, request) => service.attach(request));
  ipcMain.handle("browser:detach", (_event, request) => service.detach(request));
  for (const method of ["open", "frame", "status", "control", "input", "close"])
    ipcMain.handle("browser:" + method, (_event, request) => {
      if (method in counts) counts[method]++;
      return service[method === "close" ? "closeViewer" : method](request, "desktop");
    });
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
    webPreferences: { webviewTag: true, backgroundThrottling: false, preload: path.join(temp, "preload.cjs") },
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
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const toggle = "[data-panel-toggle=browser]";
  const page = (expression) =>
    evaluate(
      `[...document.querySelectorAll('[data-browser-page]')].find(node => node.style.pointerEvents === 'auto').querySelector('webview').executeJavaScript(${JSON.stringify(expression)})`,
    );
  try {
    // The same pin script runs inside desktop pages and the phone/iPad WebView.
    const pinWindow = new BrowserWindow({ width: 1100, height: 860, show: false });
    try {
      await pinWindow.loadURL(PAGE);
      const run = (script) => pinWindow.webContents.executeJavaScript(script);
      await run(`window.pinRoot = null; const attach = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); if (this.tagName === 'MILAGRE-PINS') window.pinRoot = root; return root; }; true;`);
      for (const width of [390, 820, 1100]) {
        pinWindow.setContentSize(width, 860);
        const pins = [
          { id: "sent", n: 0, selector: "#go", text: "Bigger button", state: "open" },
          { id: "done", n: 0, selector: "#go", text: "Resolved earlier", state: "resolved", note: "Done" },
          { id: "draft", n: 1, selector: "#name", text: "Clearer label", state: "pending" },
        ];
        assert.equal(await run(pagePinsScript(pins)), 2);
        assert.equal(await run("pinRoot.querySelectorAll('.pin').length"), 2, `resolved pins hidden at ${width}px`);
        await run("pinRoot.querySelector('.pin').dispatchEvent(new PointerEvent('pointerenter'))");
        assert.equal(await run("pinRoot.querySelector('.tip').style.display"), "block");
        pins[0].state = "resolved";
        await run(pagePinsScript(pins));
        assert.equal(await run("pinRoot.querySelectorAll('.pin').length"), 1, "resolution removes the existing pin");
        assert.equal(await run("pinRoot.querySelector('.pin').textContent"), "1", "draft numbering survives resolution");
        assert.equal(await run("pinRoot.querySelector('.tip').style.display"), "none", "resolution dismisses a hovered tooltip too");
        if (process.env.MILAGRE_SCREENSHOT_DIR) {
          fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
          fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `resolved-pins-${width}.png`), (await pinWindow.webContents.capturePage()).toPNG());
        }
        pins[2].state = "resolved";
        await run(pagePinsScript(pins));
        assert.equal(await run("document.querySelector('milagre-pins').style.display"), "none", "all resolved leaves a clear page");
      }
    } finally {
      pinWindow.destroy();
    }
    await waitUntil(async () => {
      const listed = await service.list({ chatId: "/fixture#1" });
      return listed.targets.some((target) => target.title === "Fixture login") && listed.others.length > 0;
    }, "discovered Chrome pages ready");
    await window.loadURL(url);
    await waitFor(`!!document.querySelector("${toggle}")`, "Browser button in the toolbar");
    assert.equal(counts.open, 0);
    await click(toggle);
    await waitFor("!!document.querySelector('webview')", "a native page opens");
    await waitUntil(async () => {
      try {
        return await page("!!document.getElementById('name')");
      } catch {
        return false;
      }
    }, "page loaded");
    assert.equal(counts.open, 0, "opening Browser starts no capture");
    assert.equal(await evaluate("document.querySelectorAll('iframe[data-slot=browser-frame]').length"), 0);
    assert.equal(await page("location.origin"), origin);
    await page("document.getElementById('name').value='On this device'; document.getElementById('go').click()");
    await waitFor("document.querySelector('[data-browser-tab]').textContent.includes('Signed in')", "native page title follows navigation");
    assert.equal(await page("document.getElementById('name').value"), "On this device");
    assert.ok(
      (await service.list({ chatId: "/fixture#1" })).targets.every((target) => target.title !== "Signed in"),
      "input stays in the native page",
    );
    await page("scrollTo(0,500)");
    assert.equal(await page("scrollY"), 500);
    await screenshot("native-browser");
    await click('[aria-label="Maximize browser"]');
    await waitFor('document.querySelector("[data-slot=browser-dock]").dataset.full==="true"');
    assert.ok(await evaluate('document.querySelector("[data-slot=browser-dock]").getBoundingClientRect().width > 1000'));
    await screenshot("browser-maximized");
    await click('[aria-label="Restore browser"]');
    await waitFor('!document.querySelector("[data-slot=browser-dock]").dataset.full');
    await click('[aria-label="Hide Browser panel"]');
    await waitFor("!document.querySelector('[data-slot=browser-dock]')");
    await click(toggle);
    await waitFor("!!document.querySelector('[data-slot=browser-dock]')");
    assert.equal(await page("document.getElementById('name').value"), "On this device", "hide/show preserves page state");
    await click('[aria-label="New page"]');
    await waitFor("!!document.querySelector('[data-browser-other]')", "other browsers can be attached");
    await evaluate("document.querySelector('[data-browser-other] button').click()");
    await waitUntil(async () => {
      try {
        return (await page("document.title")) === "Someone else's tab";
      } catch {
        return false;
      }
    }, "attached page loads on this device");
    assert.equal(counts.open, 0, "attaching starts no capture either");
    await waitFor("!!document.querySelector('[data-browser-detach]')", "the loaded page keeps its Detach action");
    await click("[data-browser-detach]");
    await waitFor("!document.querySelector('[data-browser-detach]')", "detaching leaves the independent page open");
    clearTimeout(watchdog);
    console.log("PASS: native Browser pages, local input and scrolling, preserved page state, attach, zero captures");
    await service.close();
    site.close();
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
    const env = { ...process.env, MILAGRE_BACKGROUND: "1" };
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
