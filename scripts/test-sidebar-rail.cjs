// Browser check: a Project left for another keeps the PR chips its rows showed (the sidebar remembers each open
// scope's rows); collapsed with two or more Projects, the sidebar shows one icon per scope with a ring for a running
// chat and an orange dot for one asking or waiting (the dot wins), resting on an icon lists its live chats and one
// opens on click, clicking another Project's icon switches to it; the Filters icon fills while a Project is hidden.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import SidebarNav from "/src/components/SidebarNav";
import { updateSettings } from "/src/lib/settings";
import { DESKTOP_CHAT_ROW_SHOW } from "@milagre/shared/chat-row";
import "/src/styles.css";
const params = new URLSearchParams(location.search);
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
  listRecentProjects: async () => params.has("single") ? recent.slice(0, 1) : recent,
  setProjectHidden: async (path, hidden) => (recent = recent.map((project) => (project.path === path ? { ...project, hidden } : project))),
  listProjects: async () => [
    { id: "p-arketa", path: "/work/arketa", name: "arketa", position: null, openedAt: "" },
    { id: "p-shop", path: "/work/shop", name: "shop", position: null, openedAt: "" },
    { id: "p-api", path: "/work/api", name: "api", position: null, openedAt: "" },
  ],
  listNamedLinks: async () => params.has("single") ? [] : [
    { id: "f1713d69-569d-405b-a0b2-19bfdf565a76", name: "Arketa + Shop + API", projectIds: ["p-arketa", "p-shop", "p-api"], createdAt: "", updatedAt: "" },
  ],
  getProjectImage: async () => null,
  listEditors: async () => [],
  chatsHome: async () => ({ path: "/work/chats", exists: params.has("home") }),
  readProject: async (path) => ({ path, name: path, state: path === "/work/chats" ? state(11, "Chat without a Project", "") : path === "/work/shop" ? state(7, "Shop chat", "/work/shop") : state(1, "Fix the login flow", "/work/arketa") }),
  readLink: async () => ({ id: "f1713d69-569d-405b-a0b2-19bfdf565a76", name: "Arketa + Shop + API", projectIds: ["p-arketa", "p-shop", "p-api"], state: state(7, "Link chat", "") }),
  onProjectState: () => () => {},
  onLinkState: () => () => {},
  patchChat: async () => {},
};
localStorage.removeItem("milagre.sidebarClosedScopes");
localStorage.removeItem("milagre.sidebarScopeOrder");
updateSettings({ chatRowShow: DESKTOP_CHAT_ROW_SHOW, chatList: params.size ? "list" : "grouped" });
const root = createRoot(document.getElementById("root"));
const arketaRows = [{ id: "1", label: "Fix the login flow", mark: "running", details: { path: "/work/arketa", branch: "main", pullRequests: [pr] } }];
arketaRows.push(
  { id: "2", label: "Idle current chat", details: { lastAt: 10 } },
  { id: "3", label: "Pinned current chat", pinned: true, pinOrder: 1 },
  { id: "4", label: "Done current chat", doneAt: Date.now() },
);
if (params.has("empty")) arketaRows.length = 0;
window.oneList = () => updateSettings({ chatList: "list" });
window.grouped = () => updateSettings({ chatList: "grouped" });
const shopRows = [{ id: "7", label: "Shop chat", details: { path: "/work/shop", branch: "main" } }];
window.render = (projectPath) =>
  root.render(
    <div style={{ display: "flex", height: "100vh", padding: "60px 12px 12px" }}>
      <SidebarNav fill workspaceName={projectPath.split("/").at(-1)} projectPath={projectPath}
        recents={projectPath === "/work/arketa" ? arketaRows : shopRows} activeId={projectPath === "/work/arketa" ? "1" : "7"}
        runningKeys={"/work/arketa#1\\n/work/shop#7"} waitingKeys={"/work/shop#7"} attentionPaths={["/work/shop"]}
        onOpenScopeChat={(key, id) => { window.opened = key + "#" + id; }}
        onSwitchProject={(path) => { window.switched = path; }}
        onSwitchLink={(id) => { window.switchedLink = id; }}
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
        ["milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76", "idle", null],
      ],
      "One icon per Project and Link with its chats' state; a waiting chat shows attention over running",
    );
    assert.deepEqual(
      await evaluate(`(() => {
        const button = document.querySelector('[data-rail-scope="milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76"]');
        const icon = button?.querySelector('[data-rail-link-icon]');
        if (!button || !icon) return null;
        const br = button.getBoundingClientRect();
        const ir = icon.getBoundingClientRect();
        return {
          width: Math.round(ir.width),
          height: Math.round(ir.height),
          inside: ir.left >= br.left && ir.right <= br.right,
          text: icon.textContent.trim(),
          hasSvg: !!icon.querySelector('svg'),
        };
      })()`),
      { width: 24, height: 24, inside: true, text: "A", hasSvg: true },
      "A Link on the collapsed rail renders a single 24px tile with the dimmed first project initial and Link icon overlay",
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
    // One list: every Chat, including idle and pinned, keeps its expanded position and opens directly.
    await evaluate(`window.oneList()`);
    await waitFor(`document.querySelectorAll("[data-chat-list-flat] [data-chat-id]").length === 4`);
    const labels = await evaluate(
      `[...document.querySelectorAll("aside [data-all-pinned] [data-chat-id], aside [data-chat-list-flat] [data-chat-id]")].map((node) => node.querySelector("[data-chat-title] .sr-only").textContent.trim())`,
    );
    assert.equal(labels.length, 5);
    await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`);
    await waitFor(`document.querySelectorAll("[data-rail-scope]").length === 5`);
    const rail = await evaluate(
      `[...document.querySelectorAll("[data-rail-scope]")].map((node) => ({ key: node.dataset.railScope, label: node.getAttribute("aria-label"), status: node.dataset.railStatus, current: node.getAttribute("aria-current") }))`,
    );
    assert.ok(
      rail.every((entry, index) => entry.label.includes(labels[index])),
      `Collapsed Chats keep the expanded One list order, pinned first: ${JSON.stringify({ labels, rail })}`,
    );
    assert.deepEqual(
      rail.filter((entry) => entry.current).map((entry) => entry.key),
      ["/work/arketa#1"],
      "Only the active Chat is marked current",
    );
    assert.equal(rail.find((entry) => entry.key === "/work/arketa#1").status, "running");
    assert.equal(rail.find((entry) => entry.key === "/work/shop#7").status, "attention");
    assert.equal(
      rail.find((entry) => entry.key === "milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76#7").status,
      "idle",
      "Identical Chat IDs in different scopes keep their own mark",
    );
    assert.ok(!rail.some((entry) => entry.key.endsWith("#4")), "Done Chats stay out of the rail");
    await evaluate(`document.querySelector('[data-rail-scope="/work/arketa#2"]').click()`);
    assert.equal(await evaluate("window.picked"), "2", "An idle Chat in the current Project opens directly");
    await evaluate(`document.querySelector('[data-rail-scope="/work/shop#7"]').click()`);
    assert.equal(await evaluate("window.opened"), "/work/shop#7", "Another Project's Chat opens directly");
    await evaluate(`document.querySelector('[data-rail-scope="milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76#7"]').click()`);
    assert.equal(await evaluate("window.opened"), "milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76#7", "A Link Chat opens directly with its scope");
    await waitFor(`Math.round(document.querySelector("aside").getBoundingClientRect().width) === 44`);
    await hover('[data-rail-scope="/work/arketa#2"]');
    await waitFor(`!!document.querySelector('[data-scope-rail-popover="/work/arketa#2"]')`);
    assert.match(await evaluate(`document.querySelector('[data-scope-rail-popover="/work/arketa#2"]').textContent`), /arketa.*Idle current chat/);
    await evaluate(`document.querySelector('[data-scope-rail-popover="/work/arketa#2"] [data-rail-chat]').click()`);
    assert.equal(await evaluate("window.picked"), "2", "Idle Chat also opens from its hover popover");
    await screenshot("one-list-rail");
    // Switching settings while collapsed changes the rail immediately and preserves the grouped behavior.
    await evaluate(`window.grouped()`);
    await waitFor(`document.querySelectorAll("[data-rail-scope]").length === 3 && !!document.querySelector('[data-rail-scope="/work/arketa"]')`);
    await evaluate(`window.oneList()`);
    await waitFor(`document.querySelectorAll("[data-rail-scope]").length === 5`);
    // Narrow-window auto collapse uses the same list, then restores the expanded list when widened.
    await evaluate(`document.querySelector('[aria-label="Expand sidebar"]').click()`);
    await waitFor(`!document.querySelector("[data-scope-rail]")`);
    window.setSize(900, 640);
    await waitFor(`document.querySelectorAll("[data-rail-scope]").length === 5`);
    window.setSize(1280, 640);
    await waitFor(`!document.querySelector("[data-scope-rail]") && document.querySelectorAll("[data-chat-list-flat] [data-chat-id]").length === 4`);
    // A single Project still uses its Project icons, and no-project Chats keep a place before Project Chats.
    await window.loadURL(process.argv[2] + "?single");
    await waitFor(`document.querySelectorAll("[data-chat-list-flat] [data-chat-id]").length === 2`);
    await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`);
    await waitFor(`document.querySelectorAll("[data-rail-scope]").length === 3`);
    assert.ok(await evaluate(`[...document.querySelectorAll("[data-rail-scope]")].every((node) => node.dataset.railScope.startsWith("/work/arketa#"))`));
    await window.loadURL(process.argv[2] + "?single&empty");
    await waitFor(`!!document.querySelector('[aria-label="Collapse sidebar"]')`);
    await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`);
    await waitFor(`!!document.querySelector("[data-scope-rail]")`);
    assert.equal(await evaluate(`document.querySelectorAll("[data-rail-scope]").length`), 0, "No Chats means an empty One list rail");
    await window.loadURL(process.argv[2] + "?home");
    await waitFor(`!!document.querySelector('[data-sidebar-chats] [data-chat-id="11"]')`);
    await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`);
    await waitFor(`document.querySelectorAll("[data-rail-scope]").length === 6`);
    assert.equal(
      await evaluate(`document.querySelectorAll("[data-rail-scope]")[1].dataset.railScope`),
      "/work/chats#11",
      "No-project Chats follow pinned Chats and precede the merged Project list",
    );
    await evaluate(`document.querySelector('[data-rail-scope="/work/chats#11"]').click()`);
    assert.equal(await evaluate("window.opened"), "/work/chats#11");
    assert.deepEqual(errors, []);
    await reset();
    console.log(
      "PASS: a Project left for another keeps its rows' PR chips; collapsed with several Projects the rail shows one icon per Project with attention over running, lists live chats on hover and opens them, switches Projects on click; the Filters icon fills while a Project is hidden; One list keeps Chat order, direct navigation, per-Chat status and active selection through collapse, setting changes and narrow windows",
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
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url.split("?")[0] !== "/__sidebar-rail") return next();
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
