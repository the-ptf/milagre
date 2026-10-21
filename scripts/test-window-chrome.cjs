// Real Electron layout and interaction checks, with native external/overlay windows and controlled geometry changes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { windowChrome } = require("../apps/desktop/electron/window-chrome.cjs");
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import SidebarNav from "/src/components/SidebarNav";
import { SettingsNav } from "/src/components/Settings";
import { DotBackground } from "/src/components/DotBackground";
import { DesignPageEditor } from "/src/components/agents/DesignPageEditor";
import { createExampleDesign, designHtml } from "@milagre/shared/design";
import { DiffBar, ChangesToggle, AttentionButton } from "/src/components/changes/ChangesChrome";
import { PanelToggles, useSidePanel } from "/src/components/agents/PanelToggles";
import { useWindowChrome } from "/src/lib/window-chrome";
import "/src/styles.css";
const designDocument = createExampleDesign();
const artifact = { id: "chrome", title: "Window controls", format: "design", version: 1, latest: 1, versions: 1, width: designDocument.width, height: designDocument.height, document: designDocument, html: designHtml(designDocument) };
window.milagre = {
  listRecentProjects: async () => [], listProjects: async () => [], listNamedLinks: async () => [],
  getProjectImage: async () => null, listEditors: async () => [],
  readDesignsEnabled: async () => ({ enabled: true }), onDesignsEnabledChanged: () => () => {}, onAgentEvent: () => () => {},
  artifacts: { list: async () => [artifact], get: async () => artifact, sharingStatus: async () => ({ available: false }) },
};
window.milagreWindowChrome = { controls: new URLSearchParams(location.search).get("controls") };
// Only geometry edge cases are simulated. The default/overlay cases use Electron's actual native API.
window.simulateGeometry = (controls, x, width, visible = true) => {
  const target = navigator.windowControlsOverlay ?? new EventTarget();
  Object.defineProperty(target, "visible", { configurable: true, value: visible });
  Object.defineProperty(target, "getTitlebarAreaRect", { configurable: true, writable: true, value: () => new DOMRect(x, 0, width, 44) });
  window.milagreWindowChrome = { controls };
  Object.defineProperty(navigator, "windowControlsOverlay", { configurable: true, value: target });
  window.dispatchEvent(new Event("resize"));
};
function Fixture() {
  const chrome = useWindowChrome();
  window.readChrome = () => chrome;
  const [changes, setChanges] = useState(false);
  const [diff, setDiff] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [settings, setSettings] = useState(false);
  const [editor, setEditor] = useState(false);
  window.showSettings = setSettings;
  window.showEditor = setEditor;
  window.showDiff = setDiff;
  useSidePanel("terminal", { open: terminal, toggle: () => setTerminal(v => !v) });
  return <><DotBackground><div style={{ width: "100%", height: "100vh", background: "#141820", color: "#ddd" }}>
    <div aria-hidden className="title-drag fixed inset-x-0 top-0 z-50 h-[var(--window-chrome-height)]" />
    {!diff && !settings && <><ChangesToggle open={changes} onToggle={() => setChanges(v => !v)} />
    <PanelToggles right={52} />
    <AttentionButton label="Review ready" items={[{ key: "1", project: "Layout", asking: false }]} offset={2} onOpen={() => window.attentionOpened = true} /></>}
    <div style={{ display: "flex", height: "100%", gap: 12 }}>
      <div data-sidebar-host className={"min-h-0 shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3 " + (settings ? "hidden" : "flex")}>
        <SidebarNav fill workspaceName="Layout" recents={[{ id: "1", label: "Check window controls" }]} activeId="1" onOpenCanvas={() => {}} onOpenCommands={() => {}} />
      </div>
      {settings && <div className="flex shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3">
        <SettingsNav section="appearance" onSelect={() => {}} onSelectProject={() => {}} showProjectSettings={false} onBack={() => window.settingsBackCalls = (window.settingsBackCalls ?? 0) + 1} />
      </div>}
      <main style={{ flex: 1, minWidth: 0, background: "#20242c", borderRadius: 12, padding: 20, margin: "var(--window-chrome-height) 12px 12px 0" }}>
        <p>Window layout check</p><p>Sidebar, changes and panels remain clickable.</p>
      </main>
    </div>
    {diff && <div data-diff-host style={{ position: "absolute", top: 0, left: 68, right: 0, height: 60 }}>
      <DiffBar open onBack={() => setDiff(false)} trailing={<button data-diff-action onClick={() => window.diffAction = true} className="h-8 px-3 bg-surface rounded-control [-webkit-app-region:no-drag]">Diff action</button>} />
    </div>}
  </div></DotBackground>
    {editor && <DesignPageEditor chatId="/chrome#1" artifact={artifact} onClose={() => setEditor(false)} />}
  </>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.env.MILAGRE_CHROME_TEST_PROFILE);
  app.on("window-all-closed", () => {});
  await app.whenReady();
  let exitCode = 0;
  try {
    for (const integrated of [false, true]) {
      const chrome = windowChrome(process.platform, integrated);
      const bridgeWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.resolve(__dirname, "../apps/desktop/electron/preload.cjs"),
          additionalArguments: [`--milagre-window-controls=${chrome.controls}`],
        },
      });
      try {
        await bridgeWindow.loadURL("about:blank");
        assert.equal(
          await bridgeWindow.webContents.executeJavaScript("window.milagreWindowChrome.controls"),
          chrome.controls,
          "the real sandboxed preload carries this window's decoration",
        );
      } finally {
        bridgeWindow.destroy();
      }
      const win = new BrowserWindow({ width: 1100, height: 650, ...chrome.options, show: true, webPreferences: { backgroundThrottling: false } });
      const evaluate = (source) =>
        win.webContents.executeJavaScript(source).catch((cause) => {
          throw new Error(`Could not evaluate: ${source}`, { cause });
        });
      const waitFor = async (source) => {
        for (let i = 0; i < 200; i++) {
          if (await evaluate(source)) return;
          await delay(25);
        }
        throw new Error(`Timed out: ${source}`);
      };
      const clickAt = (x, y) => {
        win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: Math.round(x), y: Math.round(y) });
        win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: Math.round(x), y: Math.round(y) });
      };
      const click = async (selector) => {
        const point = await evaluate(
          `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
        );
        win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      };
      const bounds = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
      const capture = async (name) => {
        if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      };
      try {
        await win.loadURL(`${process.argv[2]}?controls=${chrome.controls}`);
        await waitFor('!!document.querySelector("[data-panel-toggle=terminal]")');
        await delay(400);
        const sidebar = await bounds("[data-sidebar-toggle] button");
        assert.equal(sidebar.y, 6, "the button center stays on the 22px toolbar line");
        assert.equal(sidebar.x, await evaluate("readChrome().sidebarLeft"));
        const tools = await bounds("[data-sidebar-tools]");
        assert.equal(tools.y, 6, "Canvas, Search and Filters share the toolbar line");
        assert.ok(tools.x >= sidebar.right, "the tools follow the sidebar toggle");
        assert.ok((await evaluate("readChrome().controlsEnd")) >= tools.right + 8, "the controls end after the tools");
        if (chrome.controls === "external") assert.equal(sidebar.x, 12, "external controls need no Mac inset");
        if (chrome.controls === "overlay") {
          assert.equal(
            await evaluate("navigator.windowControlsOverlay.visible"),
            true,
            "Electron supplies controls inside a window without a native title bar",
          );
          const changes = await bounds("[data-changes-toggle]");
          const safe = await evaluate("navigator.windowControlsOverlay.getTitlebarAreaRect().toJSON()");
          assert.ok(changes.right <= safe.x + safe.width, "Changes stays out of the native control area");
        }
        await capture(integrated ? "integrated-expanded" : "native-expanded");
        await click("[data-sidebar-toggle] button");
        await waitFor('document.querySelector("aside").dataset.sidebarCollapsed === "true"');
        assert.equal((await bounds("[data-sidebar-toggle] button")).x, sidebar.x);
        await capture(integrated ? "integrated-collapsed" : "native-collapsed");
        await click("[data-changes-toggle]");
        await waitFor('document.querySelector("[data-changes-toggle]").getAttribute("aria-pressed") === "true"');
        await click("[data-panel-toggle=terminal]");
        await waitFor('document.querySelector("[data-panel-toggle=terminal]").getAttribute("aria-pressed") === "true"');
        await click("[data-attention-button]");
        await waitFor("window.attentionOpened");
        await evaluate("window.showDiff(true)");
        await waitFor('!!document.querySelector("[data-diff-back]")');
        await delay(300);
        assert.ok((await bounds("[data-diff-back]")).x >= (await evaluate("readChrome().controlsEnd")));
        await click("[data-diff-action]");
        await waitFor("window.diffAction");
        await capture(integrated ? "integrated-diff" : "native-diff");
        await click("[data-diff-back]");
        await waitFor('!document.querySelector("[data-diff-back]")');
        // A mounted sidebar inherits its hidden parent in Settings, and its local stacking stays below the real editor.
        const toggleBefore = await bounds("[data-sidebar-toggle] button");
        const collapsedBefore = await evaluate('document.querySelector("aside[data-sidebar-collapsed]").dataset.sidebarCollapsed');
        await evaluate("window.showSettings(true)");
        await waitFor(`!!document.querySelector('[aria-label="Settings navigation"]')`);
        assert.equal((await bounds("[data-sidebar-toggle] button")).width, 0, "a hidden sidebar cannot leave a visible toggle outside its parent");
        const backSelector = '[aria-label="Settings navigation"] button[aria-label="Back"]';
        const settingsBack = await bounds(backSelector);
        assert.equal(settingsBack.top, 6, "Settings Back sits in the top bar, on the toolbar line");
        assert.equal(settingsBack.x, await evaluate("readChrome().sidebarLeft"), "Settings Back starts where the sidebar toggle does");
        assert.equal((await bounds('[aria-label="Settings navigation"] > div:last-child')).top, 44, "the Settings card starts right under the bar");
        assert.equal(
          await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(backSelector)})).webkitAppRegion`),
          "no-drag",
          "Settings Back remains clickable inside the title bar",
        );
        clickAt(settingsBack.x + settingsBack.width / 2, settingsBack.y + 4);
        await waitFor("window.settingsBackCalls === 1");
        clickAt(settingsBack.x + settingsBack.width / 2, settingsBack.bottom - 4);
        await waitFor("window.settingsBackCalls === 2");
        await capture(integrated ? "integrated-settings-back" : "native-settings-back");
        await evaluate("window.showSettings(false); window.showEditor(true)");
        await waitFor('!!document.querySelector("[data-slot=design-editor]")');
        let previewReady = false;
        for (let attempt = 0; attempt < 80 && !previewReady; attempt++) {
          for (const frame of win.webContents.mainFrame.framesInSubtree) {
            if (frame === win.webContents.mainFrame) continue;
            previewReady = await frame.executeJavaScript("document.fonts.ready.then(() => !!document.querySelector('[data-design-node]'))").catch(() => false);
            if (previewReady) break;
          }
          if (!previewReady) await delay(25);
        }
        assert.ok(previewReady, "the real editor's design preview loaded before checking stacking");
        const toggleX = toggleBefore.x + toggleBefore.width / 2;
        const toggleY = toggleBefore.y + toggleBefore.height / 2;
        assert.equal(
          await evaluate(`!!document.elementFromPoint(${toggleX}, ${toggleY})?.closest('[data-slot="design-editor"]')`),
          true,
          "the real Designs editor covers the underlying sidebar toggle",
        );
        clickAt(toggleX, toggleY);
        await delay(100);
        assert.equal(
          await evaluate('document.querySelector("aside[data-sidebar-collapsed]").dataset.sidebarCollapsed'),
          collapsedBefore,
          "a click in the editor cannot toggle the sidebar behind it",
        );
        await capture(integrated ? "integrated-editor-stacking" : "native-editor-stacking");
        await evaluate("window.showEditor(false)");
        // Leading controls (including Linux decorations on the left) and fullscreen disappearance.
        await evaluate('window.simulateGeometry("leading", 80, innerWidth - 80)');
        await waitFor('document.querySelector("[data-sidebar-toggle]").getBoundingClientRect().x === 80');
        await evaluate('window.simulateGeometry("leading", 0, innerWidth, false)');
        await waitFor('document.querySelector("[data-sidebar-toggle]").getBoundingClientRect().x === 12');
        // Resizing and geometry events move every subscribed control together.
        await evaluate('window.simulateGeometry("overlay", 0, innerWidth - 160)');
        await waitFor('Math.abs(document.querySelector("[data-changes-toggle]").getBoundingClientRect().right - (innerWidth - 180)) < 1');
        await evaluate(
          'navigator.windowControlsOverlay.getTitlebarAreaRect = () => new DOMRect(0, 0, innerWidth - 200, 60); navigator.windowControlsOverlay.dispatchEvent(new Event("geometrychange"))',
        );
        await waitFor('Math.abs(document.querySelector("[data-changes-toggle]").getBoundingClientRect().right - (innerWidth - 220)) < 1');
      } finally {
        win.destroy();
      }
    }
    console.log(
      "PASS: native and integrated chrome, sidebar collapse, panels, attention, diff clearance, Settings Back clicks, hidden sidebar, real editor stacking, geometry events and fullscreen geometry",
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }
  app.exit(exitCode);
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const root = path.resolve(__dirname, "../apps/desktop");
  const server = await createServer({
    root: path.join(root, "app"),
    configFile: path.join(root, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "window-chrome-fixture",
        resolveId(id) {
          if (id === "/__chrome_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chrome_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (!request.url?.startsWith("/__chrome__")) return next();
            server
              .transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__chrome_fixture.tsx"></script></body></html>')
              .then((html) => {
                response.setHeader("Content-Type", "text/html");
                return response.end(html);
              })
              .catch((error) => {
                response.statusCode = 500;
                return response.end(String(error));
              });
          });
        },
      },
    ],
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-chrome-"));
  try {
    await server.listen();
    const env = { ...process.env, MILAGRE_CHROME_TEST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chrome__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
    // Electron holds profile files open on Windows until its process exits.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
