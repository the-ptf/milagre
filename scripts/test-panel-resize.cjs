// Browser check: the side panels' left edges drag their width like the sidebar's right edge: the git changes panel
// (ChangesPanelSlot) and a docked panel (DockSlide, as the simulator and the designs use it). Clamps, keeps the chat
// usable, persists, resets, keyboard.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ChangesPanelSlot } from "/src/components/changes/ChangesPanelSlot";
import { DockSlide } from "/src/components/agents/DockSlide";
import { roomToWiden, usePanelWidth } from "/src/components/agents/panel-width";
import { ResizeHandle } from "/src/components/primitives/ResizeHandle";
import "/src/styles.css";
document.documentElement.classList.add("dark");
function Dock() {
  const resize = usePanelWidth("simulator");
  return (
    <DockSlide
      width={resize.width}
      reserve="--simulator-dock"
      resizing={resize.resizing}
      handle={
        <ResizeHandle
          label="Resize simulator"
          side="left"
          width={resize.width}
          min={resize.min}
          max={() => roomToWiden("simulator", resize.width)}
          reset={resize.reset}
          onResize={resize.onResize}
          onCommit={resize.onCommit}
        />
      }
      data-slot="dock"
      style={{ top: 60, right: 344, bottom: 12 }}
      className="fixed z-[42]"
      panelClassName="rounded-[10px] border border-line bg-surface"
    >
      <div data-dock-card className="h-full" />
    </DockSlide>
  );
}
function App() {
  const [dock, setDock] = React.useState(false);
  window.openDock = () => setDock(true);
  return (
    <div style={{ display: "flex", gap: 12, height: "100vh" }}>
      <main data-workspace-main style={{ flex: 1, minWidth: 0 }} className="bg-surface" />
      <ChangesPanelSlot open>
        <aside data-changes-panel className="w-[var(--changes-panel-width,320px)] shrink-0 rounded-window bg-surface" />
      </ChangesPanelSlot>
      {dock && <Dock />}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1600, height: 600, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const mouse = (type, x, y, clickCount = 1) =>
    window.webContents.sendInputEvent({ type, x, y, button: "left", clickCount, modifiers: type === "mouseMove" ? ["leftButtonDown"] : [] });
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const width = (selector) => evaluate(`Math.round(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width)`);
  const handle = (label) =>
    evaluate(
      `(() => { const r = document.querySelector('[aria-label="${label}"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
  // A drag past a clamp stays inside the window: Linux drops pointer events outside it, so the drag would stop wherever
  // the last delivered move happened to land.
  const drag = async (label, wanted) => {
    const { x, y } = await handle(label);
    const inner = await evaluate("innerWidth");
    const dx = Math.min(inner - 4, Math.max(4, x + wanted)) - x;
    mouse("mouseMove", x, y);
    mouse("mouseDown", x, y);
    for (let i = 1; i <= 10; i++) {
      mouse("mouseMove", x + Math.round((dx * i) / 10), y);
      await delay(16);
    }
    mouse("mouseUp", x + dx, y);
    await delay(600);
  };
  const screenshot = async (name) => {
    const image = await window.webContents.capturePage();
    require("node:fs").writeFileSync(path.join(require("node:os").tmpdir(), `milagre-panel-resize-${name}.png`), image.toPNG());
  };
  const chat = () => width("[data-workspace-main]");
  // A panel clips its overflow while it springs open, which cuts off the outer half of its edge handle: drags wait for it
  // to settle. Slower machines (CI) are still sliding after a fixed delay.
  const settled = async (selector) => {
    const read = () =>
      evaluate(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e && !e.classList.contains("overflow-hidden") ? e.getBoundingClientRect().width : null; })()`,
      );
    for (let i = 0; i < 200; i++) {
      const before = await read();
      await delay(150);
      const after = await read();
      if (before !== null && after !== null && before > 0 && Math.abs(after - before) < 0.01) return;
    }
    throw new Error(`Timed out: ${selector} never settled`);
  };
  const changes = "Resize changes panel";
  const simulator = "Resize simulator";
  try {
    await window.loadURL(process.argv[2]);
    await evaluate("localStorage.clear()");
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-changes-panel]")');
    await settled("[data-changes-slot]");
    assert.equal(await width("[data-changes-panel]"), 320, "the changes panel starts at its default width");

    await drag(changes, -100);
    assert.equal(await width("[data-changes-panel]"), 420, "dragging its left edge left widens it");
    assert.equal(await evaluate('localStorage.getItem("milagre.panelWidth.changes")'), "420");
    await screenshot("changes-wide");
    await drag(changes, -1000);
    assert.equal(await width("[data-changes-panel]"), 640, "clamps at its max on a wide window");
    await drag(changes, 1000);
    assert.equal(await width("[data-changes-panel]"), 280, "clamps at its min");
    {
      const { x, y } = await handle(changes);
      mouse("mouseDown", x, y, 2);
      mouse("mouseUp", x, y, 2);
      await delay(600);
    }
    assert.equal(await width("[data-changes-panel]"), 320, "double-click resets it");
    await evaluate(`document.querySelector('[aria-label="${changes}"]').focus()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
    await delay(400);
    assert.equal(await width("[data-changes-panel]"), 336, "ArrowLeft widens it by 16px");

    await evaluate("window.openDock()");
    await waitFor('!!document.querySelector("[data-dock-card]")');
    await settled("[data-slot=dock]");
    assert.equal(await width("[data-slot=dock]"), 400, "the dock opens at its default width");
    assert.equal(await evaluate('document.documentElement.style.getPropertyValue("--simulator-dock")'), "412px");
    await drag(simulator, -80);
    assert.equal(await width("[data-slot=dock]"), 480, "dragging the dock's left edge widens it");
    assert.equal(await evaluate('document.documentElement.style.getPropertyValue("--simulator-dock")'), "492px", "the chat makes room as it widens");
    assert.equal(await evaluate('localStorage.getItem("milagre.panelWidth.simulator")'), "480");
    await screenshot("dock-wide");
    // Dragged far left, it stops where the chat would get narrower than 420px.
    const room = (await chat()) - 420;
    await drag(simulator, -1000);
    assert.equal(await width("[data-slot=dock]"), Math.min(800, 480 + room), "stops where the chat keeps its 420px");
    assert.ok((await chat()) >= 419, "the chat keeps its room");
    await screenshot("dock-max");

    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-changes-panel]")');
    await settled("[data-changes-slot]");
    assert.equal(await width("[data-changes-panel]"), 336, "the changes panel's width survives a reload");
    console.log("Screenshots: changes-wide, dock-wide, dock-max in the temp directory");
    console.log("PASS: changes panel and docked panel drag from their left edge, clamp, keep the chat's room, persist, reset, keyboard");
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure").catch(() => {});
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
        name: "panel-resize-fixture",
        resolveId(id) {
          if (id === "/__panel_resize_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__panel_resize_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__panel_resize__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__panel_resize_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__panel_resize__`], { env, stdio: "inherit" });
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
