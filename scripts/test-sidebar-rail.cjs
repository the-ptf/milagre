// Browser check: a Project left for another keeps the PR chips its rows showed (the sidebar remembers each open
// scope's rows); collapsed with two or more Projects, the sidebar shows one icon per scope with a ring for a running
// chat and an orange dot for one asking or waiting (the dot wins), resting on an icon lists its live chats and one
// opens on click, clicking another Project's icon switches to it; the Filters icon fills while a Project is hidden.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import SidebarNav from "/src/components/SidebarNav";
import { updateSettings } from "/src/lib/settings";
import { DESKTOP_CHAT_ROW_SHOW } from "@milagre/shared/chat-row";
import "/src/styles.css";
const pr = { number: 409, title: "Fix mobile chat archiving navigation", url: "https://github.com/x/y/pull/409", state: "OPEN" };
const state = (id, body, path) => ({
  sessions: { [id]: { id, worktree_id: 1, agent_name: "Claude", status: "Idle", summary: { count: 1, firstId: id, lastId: id, titleLine: body, lastAt: Date.now() - 5 * 60000 } } },
  worktrees: { 1: { id: 1, name: "main", path } },
  messages: [{ id, session_id: id, role: "user", body }],
});
let recent = [
  { path: "/work/arketa", name: "arketa" },
  { path: "/work/shop", name: "shop" },
  { path: "/work/api", name: "api", hidden: true },
];
window.milagre = {
  listRecentProjects: async () => recent,
  setProjectHidden: async (path, hidden) => (recent = recent.map((project) => (project.path === path ? { ...project, hidden } : project))),
  listProjects: async () => [],
  listNamedLinks: async () => [],
  getProjectImage: async () => null,
  listEditors: async () => [],
  readProject: async (path) => ({ path, name: path, state: path === "/work/shop" ? state(7, "Shop chat", "/work/shop") : state(1, "Fix the login flow", "/work/arketa") }),
  onProjectState: () => () => {},
  onLinkState: () => () => {},
  patchChat: async () => {},
};
localStorage.removeItem("milagre.sidebarClosedScopes");
localStorage.removeItem("milagre.sidebarScopeOrder");
updateSettings({ chatRowShow: DESKTOP_CHAT_ROW_SHOW });
const root = createRoot(document.getElementById("root"));
const arketaRows = [{ id: "1", label: "Fix the login flow", mark: "running", details: { path: "/work/arketa", branch: "main", pullRequests: [pr] } }];
const shopRows = [{ id: "7", label: "Shop chat", details: { path: "/work/shop", branch: "main" } }];
window.render = (projectPath) =>
  root.render(
    <div style={{ display: "flex", height: "100vh", padding: "60px 12px 12px" }}>
      <SidebarNav fill workspaceName={projectPath.split("/").at(-1)} projectPath={projectPath}
        recents={projectPath === "/work/arketa" ? arketaRows : shopRows} activeId={projectPath === "/work/arketa" ? "1" : "7"}
        runningKeys={"/work/arketa#1\\n/work/shop#7"} waitingKeys={"/work/shop#7"} attentionPaths={["/work/shop"]}
        onOpenScopeChat={(key, id) => { window.opened = key + "#" + id; }}
        onSwitchProject={(path) => { window.switched = path; }}
        onPick={(id) => { window.picked = id; }} />
    </div>,
  );
window.render("/work/arketa");
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 640, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await delay(300);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const centre = (selector) =>
    evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
  const click = async (selector) => {
    const point = await centre(selector);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await delay(200);
  };
  // Where the page last saw the pointer: a hidden window never updates :hover, but pointer events still arrive.
  const pointerOn = (selector) => `!!window.__pointer?.closest(${JSON.stringify(selector)})`;
  const trackPointer = () => evaluate(`document.addEventListener("pointerover", (event) => { window.__pointer = event.target; }, true)`);
  // Puts the pointer on an element and waits until the page has seen it arrive. A slow runner can coalesce moves, so
  // a move that didn't land is sent again.
  const hover = async (selector) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      window.webContents.sendInputEvent({ type: "mouseMove", ...(await centre(selector)) });
      for (let i = 0; i < 20; i++) {
        if (await evaluate(pointerOn(selector))) return;
        await delay(25);
      }
    }
    throw new Error(`The pointer never reached ${selector}`);
  };
  // Takes the pointer off the rail, waiting until the page has seen it leave.
  const leaveRail = async () => {
    window.webContents.sendInputEvent({ type: "mouseMove", x: 900, y: 400 });
    await waitFor(`!(${pointerOn("[data-scope-rail]")})`);
  };
  const reset = () => evaluate(`localStorage.removeItem("milagre.sidebarClosedScopes"); localStorage.removeItem("milagre.sidebarScopeOrder")`).catch(() => {});
  const chips = (scope) => evaluate(`document.querySelector('[data-sidebar-scope="${scope}"] [data-chat-id] [data-chat-prs]')?.textContent.trim() ?? ""`);
  try {
    await window.loadURL(process.argv[2]);
    await trackPointer();
    await waitFor(`!!document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id]')`);
    assert.match(await chips("/work/arketa"), /#409/, "The open Project's row shows its PR");
    assert.equal(await chips("/work/shop"), "", "Another Project's row has no PR to show");
    // Switching to shop: arketa's row keeps the PR chip it showed, so it doesn't shrink.
    await evaluate(`window.render("/work/shop")`);
    await waitFor(
      `!!document.querySelector('[data-sidebar-scope="/work/shop"][data-current]') && !!document.querySelector('[data-sidebar-scope="/work/arketa"] [data-chat-id="1"]')`,
    );
    assert.match(await chips("/work/arketa"), /#409/, "Left behind, arketa's row keeps its PR chip");
    assert.equal(
      await evaluate(`document.querySelector('[data-sidebar-scope="/work/arketa"] [data-chat-id="1"] [data-mark]')?.dataset.mark`),
      "running",
      "Its mark stays live",
    );
    await screenshot("kept-pr");
    await evaluate(`window.render("/work/arketa")`);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="/work/arketa"][data-current]')`);
    assert.match(await chips("/work/arketa"), /#409/);
    // The Filters icon fills while a Project is hidden (api is), and stays outlined with none hidden.
    const filled = () =>
      evaluate(`[...document.querySelectorAll("[data-filters] svg path")].filter((node) => node.getAttribute("fill") === "currentColor").length`);
    assert.equal(await evaluate(`document.querySelector("[data-filters]").hasAttribute("data-filters-active")`), true);
    assert.equal(await filled(), 2, "Both knobs are filled while a Project is hidden");
    assert.equal(await evaluate(`!!document.querySelector("[data-filters] .rounded-full")`), false, "No dot any more");
    await screenshot("filters-active");
    await evaluate(`document.querySelector("[data-filters]").click()`);
    await waitFor(`!!document.querySelector('[data-filters-panel] [data-sub="projects"]')`);
    await evaluate(`document.querySelector('[data-filters-panel] [data-sub="projects"]').click()`);
    await waitFor(`!!document.querySelector('[data-project-choice="/work/api"]')`);
    await evaluate(`document.querySelector('[data-project-choice="/work/api"]').click()`);
    await waitFor(`!document.querySelector("[data-filters]").hasAttribute("data-filters-active")`);
    assert.equal(await filled(), 0, "With nothing hidden the knobs are outlined");
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(`!document.querySelector("[data-filters-panel]")`);
    await evaluate(`document.querySelector('[data-filters]').click()`);
    await waitFor(`!!document.querySelector('[data-filters-panel] [data-sub="projects"]')`);
    await evaluate(`document.querySelector('[data-filters-panel] [data-sub="projects"]').click()`);
    await waitFor(`!!document.querySelector('[data-project-choice="/work/api"]')`);
    await evaluate(`document.querySelector('[data-project-choice="/work/api"]').click()`);
    await waitFor(`document.querySelector("[data-filters]").hasAttribute("data-filters-active")`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(`!document.querySelector("[data-filters-panel]")`);
    // Collapsed: one icon per Project, the open one marked, shop's dot over its ring, arketa's ring.
    await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`);
    // The sidebar narrows over 280 ms: hover only once the icons have stopped moving.
    await waitFor(`!!document.querySelector("[data-scope-rail]") && Math.round(document.querySelector("aside").getBoundingClientRect().width) === 44`);
    await delay(100);
    assert.deepEqual(
      await evaluate(
        `[...document.querySelectorAll("[data-rail-scope]")].map((node) => [node.dataset.railScope, node.dataset.railStatus, node.getAttribute("aria-current")])`,
      ),
      [
        ["/work/arketa", "running", "true"],
        ["/work/shop", "attention", null],
      ],
      "One icon per Project with its chats' state; a waiting chat shows attention over running",
    );
    assert.equal(await evaluate(`!!document.querySelector("[data-chat-id]")`), false, "No chat initials on the rail with several Projects");
    assert.equal(
      await evaluate(
        `(() => { const r = document.querySelector('[data-rail-scope="/work/shop"]').getBoundingClientRect(); const a = document.querySelector("aside").getBoundingClientRect(); return Math.round(r.left - a.left) === Math.round(a.right - r.right); })()`,
      ),
      true,
      "Icons are centred on the rail",
    );
    await screenshot("rail");
    // Resting on shop lists its live chat; clicking it opens the chat.
    await hover('[data-rail-scope="/work/shop"]');
    await waitFor(`!!document.querySelector('[data-scope-rail-popover="/work/shop"] [data-rail-chat="7"]')`);
    assert.match(await evaluate(`document.querySelector('[data-scope-rail-popover="/work/shop"]').textContent`), /shop[\\s\\S]*Shop chat/);
    assert.equal(
      await evaluate(
        `document.querySelector('[data-scope-rail-popover="/work/shop"] [data-rail-chat="7"] [data-mark], [data-scope-rail-popover="/work/shop"] [data-rail-chat="7"] svg') !== null`,
      ),
      true,
      "The live chat shows its mark",
    );
    await screenshot("rail-popover");
    await click('[data-scope-rail-popover="/work/shop"] [data-rail-chat="7"]');
    assert.equal(await evaluate("window.opened"), "/work/shop#7", "A live chat of another Project opens from the popover");
    await waitFor(`!document.querySelector("[data-scope-rail-popover]")`);
    // Clicking another Project's icon switches to it; the open one's does nothing.
    await click('[data-rail-scope="/work/shop"]');
    assert.equal(await evaluate("window.switched"), "/work/shop");
    await evaluate(`window.switched = null`);
    await click('[data-rail-scope="/work/arketa"]');
    assert.equal(await evaluate("window.switched"), null, "The open Project's icon doesn't switch");
    // Moving away closes the popover; the open Project's icon lists its own live chat and opens it in place.
    await leaveRail();
    await waitFor(`!document.querySelector("[data-scope-rail-popover]")`);
    await hover('[data-rail-scope="/work/arketa"]');
    await waitFor(`!!document.querySelector('[data-scope-rail-popover="/work/arketa"] [data-rail-chat="1"]')`);
    await click('[data-scope-rail-popover="/work/arketa"] [data-rail-chat="1"]');
    assert.equal(await evaluate("window.picked"), "1", "The open Project's chat opens through onPick");
    // Expanded again, the groups are back.
    await evaluate(`document.querySelector('[aria-label="Expand sidebar"]').click()`);
    await waitFor(`!document.querySelector("[data-scope-rail]") && !!document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id]')`);
    assert.deepEqual(errors, []);
    await reset();
    console.log(
      "PASS: a Project left for another keeps its rows' PR chips; collapsed with several Projects the rail shows one icon per Project with attention over running, lists live chats on hover and opens them, switches Projects on click; the Filters icon fills while a Project is hidden",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    await reset();
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-sidebar-rail"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "sidebar-rail-fixture",
        resolveId(id) {
          if (id === "/__sidebar-rail.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar-rail.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__sidebar-rail") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__sidebar-rail.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar-rail`], {
      env,
      stdio: "inherit",
    });
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
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
