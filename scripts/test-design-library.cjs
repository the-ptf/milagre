// Run with node scripts/test-design-library.cjs. Checks the Project's Design library page: the sidebar Project menu
// opens it with no Chat; its library pages and most recent edits run down the left, and the chosen page's designs lie
// side by side on the library canvas (All has a row per page) with versions and who saved each, and one switch sets every
// design's color mode; a recent edit shows its
// design, moving to its page; a frame's ⋯ menu renames and moves it, its delete removes it, through the host; a page
// renames; the page follows the host's change event; and an empty library says how designs get there. Set
// MILAGRE_SCREENSHOT_DIR to keep screenshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const screen = (title, fill) => ({
  schemaVersion: 1,
  width: 390,
  height: 844,
  tokens: { screen: { light: "#f4f1ec", dark: "#121412" } },
  background: "$screen",
  nodes: [
    { id: "card", type: "rectangle", x: 24, y: 120, width: 342, height: 220, fill, radius: 24 },
    { id: "title", type: "text", x: 24, y: 56, width: 342, height: 40, text: title, fontSize: 30, fontWeight: 700, fill: "#1f2a24" },
  ],
});

const fixture = `
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { designHtml } from "@milagre/shared/design";
import { ScopeHeader } from "/src/components/sidebar/ScopeHeader";
import { projectMenu } from "/src/components/sidebar/project-menu";
import { DesignLibraryView } from "/src/components/design-library/DesignLibraryView";
import { leavesOnEscape } from "/src/lib/run-pane";
import { isModalOpen } from "/src/lib/modal";
import "/src/styles.css";
const docs = { home: ${JSON.stringify(screen("Home", "#2f6f4f"))}, watch: ${JSON.stringify(screen("Rings", "#c2410c"))}, kit: ${JSON.stringify(screen("Buttons", "#6d28d9"))} };
const entry = (id, title, page, version, edits) => ({ id: "library:" + id, title, page, version, versions: version, format: "design", width: 390, height: 844, edits });
window.calls = [];
window.listeners = new Set();
window.pages = { iphone: "iPhone", watch: "Watch" };
window.designs = [
  entry("home", "Home", "iphone", 2, [{ version: 1, chatId: "/repo#3", chat: "Onboarding", agent: "Claude", at: Date.now() - 3 * 3600000 }, { version: 2, chatId: "/repo#4", chat: "Polish", agent: "Codex", at: Date.now() - 2 * 3600000 }]),
  entry("watch", "Rings", "watch", 1, [{ version: 1, chatId: "/repo#5", chat: "Watch face", agent: "Claude", at: Date.now() - 600000 }]),
];
window.changed = () => window.listeners.forEach((listener) => listener({ projectPath: "/repo" }));
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
window.milagre = {
  readDesignsEnabled: async () => ({ enabled: true }),
  onDesignsEnabledChanged: () => () => {},
  artifacts: {
    library: async (request) => {
      window.calls.push(["list", request]);
      const used = [...new Set(window.designs.map((design) => design.page))];
      return { pages: used.map((id) => ({ id, name: window.pages[id], designs: window.designs.filter((design) => design.page === id) })) };
    },
    get: async (request) => {
      window.calls.push(["get", request]);
      const found = window.designs.find((design) => design.id === request.id);
      if (!found) throw new Error("This design isn't in the Project library.");
      const document = docs[request.id.slice("library:".length)];
      return { ...found, version: request.version ?? found.version, latest: found.version, document, html: designHtml(document) };
    },
    delete: async (request) => {
      window.calls.push(["delete", request]);
      window.designs = window.designs.filter((design) => design.id !== request.id);
      window.changed();
      return { id: request.id };
    },
    updateLibraryDesign: async (request) => {
      window.calls.push(["update", request]);
      let found = window.designs.find((design) => design.id === request.id);
      if (request.title) found = { ...found, title: request.title, version: found.version + 1, versions: found.version + 1, edits: [...found.edits, { version: found.version + 1, at: Date.now() }] };
      if (request.page) {
        const id = Object.keys(window.pages).find((key) => window.pages[key] === request.page) ?? slug(request.page);
        window.pages[id] = request.page;
        found = { ...found, page: id };
      }
      window.designs = window.designs.map((design) => (design.id === request.id ? found : design));
      window.changed();
      return found;
    },
    renameLibraryPage: async (request) => {
      window.calls.push(["rename-page", request]);
      window.pages[request.page] = request.name;
      window.changed();
      return { id: request.page, name: request.name };
    },
    onLibraryChanged: (listener) => {
      window.listeners.add(listener);
      return () => window.listeners.delete(listener);
    },
  },
};
// The app's layout: the sidebar beside the main area, where the Design library is a view like Canvas or Routines and
// Escape leaves it as the app's shortcut does.
function Fixture() {
  const [view, setView] = useState("chat");
  window.appView = view;
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (leavesOnEscape(view, isModalOpen() || document.documentElement.hasAttribute("data-popover-open"))) setView("chat");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);
  return <div style={{ display: "flex", height: "100vh" }}>
    <aside style={{ width: 260, flexShrink: 0, padding: "56px 0 0" }}>
      <ScopeHeader name="Habits" icon={<span>H</span>} open current attention={false} onToggle={() => {}} menu={projectMenu({ key: "/repo", name: "Habits" }, () => {})} />
      <button data-fixture-chat onClick={() => setView("chat")}>Login screens</button>
    </aside>
    <main data-workspace-main style={{ display: "flex", flex: 1, minWidth: 0, position: "relative" }}>
      <DesignLibraryView view={view} onShow={setView} />
      {view === "chat" && <div data-fixture-chat-pane style={{ flex: 1 }}>Chat</div>}
    </main>
  </div>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-design-library-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 860, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error" && !/Content Security Policy/.test(details.message)) console.error(details.message);
  });
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(`${error.message}\n  in: ${source.slice(0, 300)}`);
    });
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(300);
    const fs = require("node:fs");
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `design-library-${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const page = 'document.querySelector("[data-slot=design-library-page]")';
  const frames = `${page}?.querySelectorAll("[data-slot=artifact-frame]")`;
  const frame = (id) => `${page}.querySelector('[data-slot=artifact-frame][data-artifact="library:${id}"]')`;
  const painted = (id) => `!!${frame(id)}?.querySelector("[data-design-body][data-painted]")`;
  const rows = `[...${page}.querySelectorAll("[data-slot=library-page-row]")]`;
  const row = (name) => `${rows}.find((node) => node.querySelector("button").textContent.startsWith(${JSON.stringify(name)}))`;
  const current = `${rows}.find((node) => node.querySelector("[aria-current=page]"))?.querySelector("button").textContent`;
  const recent = `[...${page}.querySelectorAll("[data-slot=library-recent-edit]")]`;
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const type = (selector, text) =>
    evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
    );
  const frameAction = async (id, slot) => {
    await evaluate(`${frame(id)}.querySelector("[data-slot=artifact-more]").click()`);
    await waitFor(`!!document.querySelector("[role=menu] [data-slot=${slot}]")`);
    await click(`[role=menu] [data-slot=${slot}]`);
  };
  try {
    await window.loadURL(process.argv[2]);
    // The sidebar's Project menu opens the page; it reads the library by the Project's path, with no Chat.
    await waitFor('!!document.querySelector("[data-scope-menu]")');
    await click("[data-scope-menu]");
    await waitFor('!!document.querySelector("[data-scope-menu-item=design-library]")');
    assert.equal(await evaluate('document.querySelector("[data-scope-menu-item=design-library]").textContent'), "Design library");
    await click("[data-scope-menu-item=design-library]");
    await waitFor(`${frames}?.length === 2 && ${painted("home")} && ${painted("watch")}`);
    assert.deepEqual(await evaluate('window.calls.find(([kind]) => kind === "list")[1]'), { projectPath: "/repo" });
    assert.equal(
      await evaluate(
        'window.calls.some(([kind, request]) => kind === "get" && request.projectPath === "/repo" && request.id === "library:home" && request.version === 2)',
      ),
      true,
    );
    assert.equal(await evaluate("window.appView"), "design-library", "a view of the main area, not a dialog");
    assert.equal(
      await evaluate('!!document.querySelector("[data-workspace-main] [data-slot=design-library-page]") && !document.querySelector("dialog[open]")'),
      true,
    );
    assert.equal(await evaluate(`${page}.querySelector("[data-slot=library-title]").textContent`), "Habits · Design library");
    // The pages down the left, All first; All lays the designs out in a row per page, with who saved each version.
    assert.deepEqual(await evaluate(`${rows}.map((node) => node.querySelector("button").textContent)`), ["All designs2", "iPhone1", "Watch1"]);
    assert.equal(await evaluate(current), "All designs2");
    assert.deepEqual(await evaluate(`[...${page}.querySelectorAll("[data-slot=artifact-canvas-group]")].map((node) => node.dataset.group)`), [
      "iPhone",
      "Watch",
    ]);
    assert.match(await evaluate(`${frame("home")}.textContent`), /v2 of 2.*Edited in Polish · Codex/);
    // Recent edits, newest first, name the page, the version, who saved it and when.
    assert.deepEqual(await evaluate(`${recent}.map((node) => node.dataset.design)`), ["library:watch", "library:home"]);
    assert.equal(await evaluate(`${recent}[1].textContent`), "HomeCodex in Polish · 2 h ago");
    assert.equal(await evaluate(`${recent}[1].getAttribute("aria-label")`), "Show Home. iPhone · v2 · Edited in Polish · Codex · 2 h ago");
    await screenshot("all");

    // The page's designs define Dark, so one switch above the canvas sets every design's mode; a frame's own choice
    // makes the page mixed, with no segment chosen.
    const pageMode = `${page}.querySelector("[data-slot=library-page-mode]")`;
    const checkedMode = `${pageMode}?.querySelector("[role=radio][aria-checked=true]")?.textContent ?? null`;
    await waitFor(`!!${pageMode}`);
    assert.deepEqual(await evaluate(`[...${pageMode}.querySelectorAll("[role=radio]")].map((node) => node.textContent)`), ["Light", "Dark"]);
    assert.equal(await evaluate(checkedMode), "Light");
    await evaluate(`${pageMode}.querySelector("[data-library-mode=dark]").click()`);
    await waitFor(`${checkedMode} === "Dark"`);
    await evaluate(`${frame("watch")}.querySelector("[data-slot=artifact-more]").click()`);
    await waitFor('!!document.querySelector("[role=menu] [data-slot=artifact-mode][aria-checked=true]")');
    assert.equal(await evaluate('document.querySelector("[role=menu] [data-slot=artifact-mode][aria-checked=true]").textContent'), "Dark");
    await evaluate('[...document.querySelectorAll("[role=menu] [data-slot=artifact-mode]")].find((node) => node.textContent === "Light").click()');
    await waitFor(`${checkedMode} === null`);
    await screenshot("page-mode");
    await evaluate(`${pageMode}.querySelector("[data-library-mode=light]").click()`);
    await waitFor(`${checkedMode} === "Light"`);

    // A page shows only its designs.
    await evaluate(`${row("Watch")}.querySelector("button").click()`);
    await waitFor(`${frames}.length === 1 && ${painted("watch")}`);
    assert.equal(await evaluate(current), "Watch1");
    // Renaming the page goes to the host and the row follows its change event.
    await evaluate(`${row("Watch")}.querySelector("[data-slot=library-page-more]").click()`);
    await waitFor('!!document.querySelector("[role=menu] [data-slot=library-rename-page]")');
    await click("[role=menu] [data-slot=library-rename-page]");
    await waitFor('!!document.querySelector("[data-slot=library-rename] [data-slot=library-name]")');
    await type("[data-slot=library-name]", "Apple Watch");
    await waitFor('!document.querySelector("[data-slot=library-rename-save]").disabled');
    await click("[data-slot=library-rename-save]");
    await waitFor(`!document.querySelector("[data-slot=library-rename]") && !!${row("Apple Watch")}`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "rename-page")[1]'), {
      projectPath: "/repo",
      page: "watch",
      name: "Apple Watch",
    });
    // A recent edit of a design on another page moves to its page and shows it.
    await evaluate(`${recent}.find((node) => node.dataset.design === "library:home").click()`);
    await waitFor(`${frames}.length === 1 && ${painted("home")}`);
    assert.equal(await evaluate(current), "iPhone1");

    // The frame steps back through its versions, naming who saved each.
    await evaluate(`${frame("home")}.querySelector("[aria-label='Previous version of Home']").click()`);
    await waitFor(`/v1 of 2.*Edited in Onboarding · Claude/.test(${frame("home")}.textContent)`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "get")[1]'), { projectPath: "/repo", id: "library:home", version: 1 });
    await screenshot("page");
    // Zoomed in, the canvas pans only by its own transform: focus moving to a frame's menu can't scroll it aside.
    for (let step = 0; step < 4; step++) await click('[data-slot=library-board] [aria-label="Zoom in"]');
    const canvasEl = 'document.querySelector("[data-slot=library-board] [data-slot=artifact-canvas]")';
    assert.equal(await evaluate(`(() => { const c = ${canvasEl}; c.scrollLeft = 200; c.scrollTop = 200; return c.scrollLeft + c.scrollTop; })()`), 0);
    await evaluate(`${row("All designs")}.querySelector("button").click()`);
    await waitFor(`${frames}.length === 2`);

    // Rename from the frame's ⋯ menu: a new library version the page made, read back on the change event.
    await frameAction("home", "library-rename-design");
    await waitFor('!!document.querySelector("[data-slot=library-rename] [data-slot=library-name]")');
    await type("[data-slot=library-name]", "Start");
    await click("[data-slot=library-rename-save]");
    await waitFor(`/v3 of 3.*Edited in the Design library/.test(${frame("home")}?.textContent ?? "") && /Start/.test(${recent}[0]?.textContent ?? "")`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "update")[1]'), { projectPath: "/repo", id: "library:home", title: "Start" });

    // Move to a new page: its row appears and the emptied page's goes.
    await frameAction("home", "library-move-design");
    await waitFor('!!document.querySelector("[data-slot=library-move] [data-slot=library-page-name]")');
    assert.equal(await evaluate('document.querySelector("[data-slot=library-move-save]").disabled'), true, "staying on its page is no move");
    await click('[data-slot=library-move] [aria-label="New page"]');
    await type("[data-slot=library-move] [data-slot=library-page-name]", "Kit");
    await waitFor('!document.querySelector("[data-slot=library-move-save]").disabled');
    await screenshot("move");
    await click("[data-slot=library-move-save]");
    await waitFor(`!!${row("Kit")} && !${row("iPhone")}`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "update")[1]'), { projectPath: "/repo", id: "library:home", page: "Kit" });

    // An agent in a Chat of the Project saves a new version: the page reads the library again.
    await evaluate(
      `window.designs = window.designs.map((d) => d.id === "library:watch" ? { ...d, version: 2, versions: 2, edits: [...d.edits, { version: 2, chatId: "/repo#6", chat: "Night mode", agent: "Codex", at: Date.now() }] } : d); window.changed();`,
    );
    await waitFor(`/v2 of 2.*Edited in Night mode · Codex/.test(${frame("watch")}?.textContent ?? "") && ${recent}[0]?.dataset.design === "library:watch"`);

    // The frame's delete asks first, then removes it for every Chat.
    await evaluate(`${frame("watch")}.querySelector("[data-slot=artifact-delete]").click()`);
    await waitFor('!!document.querySelector("[data-slot=artifact-delete-confirm]")');
    await screenshot("delete");
    await click("[data-slot=artifact-delete-confirm]");
    await waitFor(`${frames}.length === 1 && !${frame("watch")}`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "delete")[1]'), { projectPath: "/repo", id: "library:watch" });

    // Escape over a dialog closes the dialog, not the page; then it leaves the page for the Chat, as other views do.
    await frameAction("home", "library-rename-design");
    await waitFor('!!document.querySelector("[data-slot=library-rename]")');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor('!document.querySelector("[data-slot=library-rename]")');
    assert.equal(await evaluate("window.appView"), "design-library");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor('window.appView === "chat" && !document.querySelector("[data-slot=design-library-page]")');
    // The palette and the Artifact panel open it the same way; choosing a Chat in the sidebar leaves it.
    await evaluate('window.dispatchEvent(new CustomEvent("milagre:design-library", { detail: { projectKey: "/repo", name: "Habits" } }))');
    await waitFor(`window.appView === "design-library" && ${frames}?.length === 1`);
    await click("[data-fixture-chat]");
    await waitFor('window.appView === "chat" && !document.querySelector("[data-slot=design-library-page]")');
    await click("[data-scope-menu]");
    await waitFor('!!document.querySelector("[data-scope-menu-item=design-library]")');
    await click("[data-scope-menu-item=design-library]");
    await waitFor(`${frames}?.length === 1`);

    // With nothing left the page says how designs get here.
    await evaluate("window.designs = []; window.changed();");
    await waitFor(`!!${page}.querySelector("[data-slot=library-empty]")`);
    assert.match(await evaluate(`${page}.querySelector("[data-slot=library-empty]").textContent`), /Add to Project library.*ask an agent/);
    await screenshot("empty");
    console.log(
      "PASS: the Project menu opens the Design library as a view of the main area with no Chat, titled in the top bar; Escape (past a dialog) or a Chat leaves it; pages and recent edits down the left, the page's designs on the library canvas with versions and who saved each; a recent edit moves to its page; rename, move, page rename and delete go through the host; changes from any Chat show; an empty library says how designs get there",
    );
    app.exit(0);
  } catch (error) {
    await screenshot("failure");
    console.error(error);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: "design-library-fixture",
        resolveId(id) {
          if (id === "/__design_library_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__design_library_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__design_library__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__design_library_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__design_library__`], { env, stdio: "inherit" });
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
