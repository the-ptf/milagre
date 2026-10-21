// Browser check: dragging the sidebar's right edge resizes it, clamps, persists, and resets.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import SidebarNav from "/src/components/SidebarNav";
import "/src/styles.css";
// bridgeFor(null) needs an object for its WeakMap, even in this renderer-only fixture.
window.milagre = {};
const recents = [
  { id: "1", label: "lets pick the next 3 issues from the tracker and plan them" },
  { id: "2", label: "the chat names arent reflecting the first message" },
  { id: "3", label: "when i navigate between chats the scroll jumps" },
];
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(
  <div style={{ display: "flex", height: "100vh", padding: "60px 12px 12px" }}>
    <SidebarNav fill workspaceName="agent-sessions-pr2" recents={recents} activeId="1" />
    <div style={{ flex: 1 }} />
  </div>
);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1200, height: 500, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error("Sidebar renderer:", details.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  let dragging = false;
  // Only moves during a drag carry leftButtonDown; the positioning move has no pressed button.
  const mouse = (type, x, y) => {
    window.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1, modifiers: type === "mouseMove" && dragging ? ["leftButtonDown"] : [] });
    if (type === "mouseDown") dragging = true;
    if (type === "mouseUp") dragging = false;
  };
  async function waitFor(source) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    const observed = await evaluate(`(() => {
      const aside = document.querySelector("aside");
      return { width: aside?.getBoundingClientRect().width, inline: aside?.style.width,
        collapsed: aside?.dataset.sidebarCollapsed, saved: localStorage.getItem("milagre.sidebarWidth"),
        cursor: document.body.style.cursor, value: document.querySelector('[aria-label="Resize sidebar"]')?.getAttribute("aria-valuenow"),
        animations: aside?.getAnimations().map(a => ({ state: a.playState, time: a.currentTime })) };
    })()`);
    throw new Error(`Timed out: ${source}\nObserved: ${JSON.stringify(observed)}`);
  }
  const width = () => evaluate('document.querySelector("aside").getBoundingClientRect().width');
  const handle = () =>
    evaluate(
      '(() => { const r = document.querySelector("[aria-label=\\"Resize sidebar\\"]").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()',
    );
  // Queueing mouseUp is not its commit: React can apply it later, starting a width transition. Wait for
  // persistence, the exact rendered width and the transition's end before reading or targeting the next handle.
  const settled = (expected, saved = String(expected)) =>
    waitFor(`(() => {
    const aside = document.querySelector("aside");
    return aside?.style.width === "${expected}px" && aside.getBoundingClientRect().width === ${expected}
      && aside.getAnimations().length === 0 && document.body.style.cursor === ""
      && localStorage.getItem("milagre.sidebarWidth") === ${JSON.stringify(saved)};
  })()`);
  const drag = async (wanted, expected) => {
    const { x, y } = await handle();
    // Linux drops injected events outside the window, including the pointerup that commits the width.
    const inner = await evaluate("innerWidth");
    const dx = Math.min(inner - 4, Math.max(4, x + wanted)) - x;
    mouse("mouseMove", x, y);
    mouse("mouseDown", x, y);
    await waitFor('document.body.style.cursor === "col-resize"');
    for (let i = 1; i <= 10; i++) {
      mouse("mouseMove", x + Math.round((dx * i) / 10), y);
      await delay(16);
    }
    mouse("mouseUp", x + dx, y);
    await settled(expected);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: 640, height: 500 });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `sidebar-${name}.png`), image.toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await evaluate('localStorage.removeItem("milagre.sidebarWidth")');
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("aside")');
    await settled(224, null);
    assert.equal(await width(), 224, "starts at the default width");
    await screenshot("default");
    {
      // Mid-drag, so the edge line shows.
      const { x, y } = await handle();
      mouse("mouseDown", x, y);
      await waitFor('document.body.style.cursor === "col-resize"');
      for (let i = 1; i <= 10; i++) {
        mouse("mouseMove", x + i * 8, y);
        await delay(16);
      }
      await delay(100);
      await screenshot("dragging");
      mouse("mouseUp", x + 80, y);
      await settled(304);
      await evaluate('document.querySelector("[aria-label=\\"Resize sidebar\\"]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
      await settled(224);
    }
    await drag(100, 324);
    assert.equal(await width(), 324, "drag right widens it");
    assert.equal(await evaluate('localStorage.getItem("milagre.sidebarWidth")'), "324");
    await screenshot("wide");
    await drag(400, 420);
    assert.equal(await width(), 420, "clamps at the max");
    await screenshot("max");
    await drag(-600, 224);
    assert.equal(await width(), 224, "clamps at the min");
    await drag(150, 374);
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("aside")');
    await settled(374);
    assert.equal(await width(), 374, "width survives a reload");
    await evaluate('document.querySelector("[aria-label=\\"Collapse sidebar\\"]").click()');
    await settled(44, "374");
    assert.equal(await width(), 44, "collapses to the rail");
    await screenshot("collapsed");
    assert.equal(await evaluate('document.querySelector("[aria-label=\\"Resize sidebar\\"]")'), null, "no handle on the rail");
    await evaluate('document.querySelector("[aria-label=\\"Expand sidebar\\"]").click()');
    await settled(374);
    assert.equal(await width(), 374, "expands back to the chosen width");
    const { x, y } = await handle();
    window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 2 });
    window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 2 });
    await settled(224);
    assert.equal(await width(), 224, "double-click resets");
    const key = async (keyCode, expected, modifiers = []) => {
      await evaluate('document.querySelector("[aria-label=\\"Resize sidebar\\"]").focus()');
      window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await settled(expected);
      assert.equal(await width(), expected, `${keyCode} commits ${expected}px`);
    };
    await key("Right", 240);
    await key("Left", 224);
    await key("Right", 272, ["shift"]);
    await key("End", 420);
    await key("Home", 224);
    await drag(0, 224);
    // Longer than the former 400ms sleep, then no motion: both paths must settle without a transitionend dependency.
    await evaluate('document.documentElement.style.setProperty("--motion-scale", "4")');
    await key("End", 420);
    await evaluate('document.querySelector("[aria-label=\\"Collapse sidebar\\"]").click()');
    await settled(44, "420");
    await evaluate('document.querySelector("[aria-label=\\"Expand sidebar\\"]").click()');
    await settled(420);
    await evaluate('document.documentElement.style.setProperty("--motion-scale", "0")');
    await key("Left", 404);
    console.log("PASS: Left/Right, Shift step, Home/End, stationary drag, slow and zero-duration transitions");
    console.log("PASS: drag widens, clamps 224..420, persists across reload, hidden when collapsed, restores on expand, double-click reset, keyboard");
    app.exit(0);
  } catch (error) {
    await screenshot("failure").catch(() => {});
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
        name: "sidebar-resize-fixture",
        resolveId(id) {
          if (id === "/__sidebar_resize_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar_resize_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__sidebar_resize__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__sidebar_resize_fixture.tsx"></script></body></html>',
            );
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          });
        },
      },
    ],
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-sidebar-resize-"));
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar_resize__`, `--user-data-dir=${profile}`], {
      env,
      stdio: "inherit",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
