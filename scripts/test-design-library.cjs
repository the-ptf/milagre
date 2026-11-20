// Run with node scripts/test-design-library.cjs. Checks the Project's Design library page: the sidebar Project menu
// opens it with no Chat, its library pages are tabs after All, each design is a card with a drawn preview, title, size
// and who saved it when; a card opens on the library canvas with versions, and its ⋯ menu renames, moves and deletes
// it through the host; a page renames; the page follows the host's change event; and an empty library says how
// designs get there. Set MILAGRE_SCREENSHOT_DIR to keep screenshots.
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
  const cards = 'document.querySelectorAll("[data-slot=design-library-page] [data-slot=library-card]")';
  const card = (id) => `document.querySelector('[data-slot=design-library-page] [data-slot=library-card][data-design="library:${id}"]')`;
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const tab = (name) => `[...${page}.querySelectorAll("[role=tab]")].find((node) => node.textContent.startsWith(${JSON.stringify(name)}))`;
  const type = (selector, text) =>
    evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
    );
  const cardAction = async (id, slot) => {
    await evaluate(`${card(id)}.querySelector("[data-slot=library-card-more]").click()`);
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
    await waitFor(`${cards}?.length === 2 && [...${cards}].every((node) => !!node.querySelector("iframe"))`);
    assert.deepEqual(await evaluate('window.calls.find(([kind]) => kind === "list")[1]'), { projectPath: "/repo" });
    assert.deepEqual(await evaluate('window.calls.find(([kind]) => kind === "get")[1]'), { projectPath: "/repo", id: "library:home", version: 2 });
    assert.equal(await evaluate("window.appView"), "design-library", "a view of the main area, not a dialog");
    assert.equal(
      await evaluate('!!document.querySelector("[data-workspace-main] [data-slot=design-library-page]") && !document.querySelector("dialog[open]")'),
      true,
    );
    assert.equal(await evaluate(`${page}.querySelector("[data-slot=library-title]").textContent`), "Habits · Design library");
    assert.deepEqual(await evaluate(`[...${page}.querySelectorAll("[role=tab]")].map((node) => node.textContent)`), ["All2", "iPhone1", "Watch1"]);
    assert.match(await evaluate(`${card("home")}.textContent`), /Home.*iPhone · 390 × 844.*v2 · Edited in Polish · Codex · 2 h ago/);
    await screenshot("all");

    // A page tab shows only its designs, without naming the page on each card.
    await evaluate(`${tab("Watch")}.click()`);
    await waitFor(`${cards}.length === 1 && !!${card("watch")}`);
    assert.doesNotMatch(await evaluate(`${card("watch")}.textContent`), /Watch ·/);
    // Renaming the page goes to the host and the tab follows its change event.
    await click("[data-slot=library-page-more]");
    await waitFor('!!document.querySelector("[role=menu] [data-slot=library-rename-page]")');
    await click("[role=menu] [data-slot=library-rename-page]");
    await waitFor('!!document.querySelector("[data-slot=library-rename] [data-slot=library-name]")');
    await type("[data-slot=library-name]", "Apple Watch");
    await waitFor('!document.querySelector("[data-slot=library-rename-save]").disabled');
    await click("[data-slot=library-rename-save]");
    await waitFor(`!document.querySelector("[data-slot=library-rename]") && !!${tab("Apple Watch")}`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "rename-page")[1]'), {
      projectPath: "/repo",
      page: "watch",
      name: "Apple Watch",
    });
    await evaluate(`${tab("All")}.click()`);
    await waitFor(`${cards}.length === 2`);

    // A card opens the design large on the library canvas, with its versions and who saved each.
    await evaluate(`${card("home")}.querySelector("button").click()`);
    const frame = `${page}.querySelector('[data-slot=artifact-frame][data-artifact="library:home"]')`;
    await waitFor(`!!${frame}?.querySelector("[data-design-body][data-painted]")`);
    assert.match(await evaluate(`${frame}.textContent`), /v2 of 2.*Edited in Polish · Codex/);
    assert.equal(await evaluate(`${page}.querySelector("[data-slot=library-title]").textContent`), "Habits · Design library");
    await screenshot("open");
    await evaluate(`${frame}.querySelector("[aria-label='Previous version of Home']").click()`);
    await waitFor(`/v1 of 2.*Edited in Onboarding · Claude/.test(${frame}.textContent)`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "get")[1]'), { projectPath: "/repo", id: "library:home", version: 1 });
    await click("[data-slot=library-back]");
    await waitFor(`${cards}?.length === 2`);

    // Rename: a new library version the page made, read back on the change event.
    await cardAction("home", "library-rename-design");
    await waitFor('!!document.querySelector("[data-slot=library-rename] [data-slot=library-name]")');
    await type("[data-slot=library-name]", "Start");
    await click("[data-slot=library-rename-save]");
    await waitFor(`/Start.*v3 · Edited in the Design library · just now/.test(${card("home")}?.textContent ?? "")`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "update")[1]'), { projectPath: "/repo", id: "library:home", title: "Start" });

    // Move to a new page: the tab appears.
    await cardAction("home", "library-move-design");
    await waitFor('!!document.querySelector("[data-slot=library-move] [data-slot=library-page-name]")');
    assert.equal(await evaluate('document.querySelector("[data-slot=library-move-save]").disabled'), true, "staying on its page is no move");
    await click('[data-slot=library-move] [aria-label="New page"]');
    await type("[data-slot=library-move] [data-slot=library-page-name]", "Kit");
    await waitFor('!document.querySelector("[data-slot=library-move-save]").disabled');
    await screenshot("move");
    await click("[data-slot=library-move-save]");
    await waitFor(`!!${tab("Kit")} && !${tab("iPhone")}`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "update")[1]'), { projectPath: "/repo", id: "library:home", page: "Kit" });

    // An agent in a Chat of the Project saves a new version: the page reads the library again.
    await evaluate(
      `window.designs = window.designs.map((d) => d.id === "library:watch" ? { ...d, version: 2, versions: 2, edits: [...d.edits, { version: 2, chatId: "/repo#6", chat: "Night mode", agent: "Codex", at: Date.now() }] } : d); window.changed();`,
    );
    await waitFor(`/v2 · Edited in Night mode · Codex/.test(${card("watch")}?.textContent ?? "")`);

    // Delete asks first, then removes it for every Chat.
    await cardAction("watch", "library-delete-design");
    await waitFor('!!document.querySelector("[data-slot=library-delete]")');
    await screenshot("delete");
    await click("[data-slot=library-delete-confirm]");
    await waitFor(`${cards}.length === 1 && !${card("watch")}`);
    assert.deepEqual(await evaluate('window.calls.findLast(([kind]) => kind === "delete")[1]'), { projectPath: "/repo", id: "library:watch" });

    // Escape over a dialog closes the dialog, not the page; then it leaves the page for the Chat, as other views do.
    await cardAction("home", "library-rename-design");
    await waitFor('!!document.querySelector("[data-slot=library-rename]")');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor('!document.querySelector("[data-slot=library-rename]")');
    assert.equal(await evaluate("window.appView"), "design-library");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor('window.appView === "chat" && !document.querySelector("[data-slot=design-library-page]")');
    // The palette and the Artifact panel open it the same way; choosing a Chat in the sidebar leaves it.
    await evaluate('window.dispatchEvent(new CustomEvent("milagre:design-library", { detail: { projectKey: "/repo", name: "Habits" } }))');
    await waitFor(`window.appView === "design-library" && ${cards}?.length === 1`);
    await click("[data-fixture-chat]");
    await waitFor('window.appView === "chat" && !document.querySelector("[data-slot=design-library-page]")');
    await click("[data-scope-menu]");
    await waitFor('!!document.querySelector("[data-scope-menu-item=design-library]")');
    await click("[data-scope-menu-item=design-library]");
    await waitFor(`${cards}?.length === 1`);

    // With nothing left the page says how designs get here.
    await evaluate("window.designs = []; window.changed();");
    await waitFor(`!!${page}.querySelector("[data-slot=library-empty]")`);
    assert.match(await evaluate(`${page}.querySelector("[data-slot=library-empty]").textContent`), /Add to Project library.*ask an agent/);
    await screenshot("empty");
    console.log(
      "PASS: the Project menu opens the Design library as a view of the main area with no Chat, titled in the top bar; Escape (past a dialog) or a Chat leaves it; page tabs after All, cards with previews, size and who saved them when; a card opens on the library canvas with versions; rename, move, page rename and delete go through the host; changes from any Chat show; an empty library says how designs get there",
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
