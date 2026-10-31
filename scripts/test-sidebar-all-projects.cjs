// Browser check: the sidebar lists each recent Project and
// Link with its chats, leaves out a hidden Project, shows and hides Projects from the chooser's checkboxes, marks exactly one open scope, shows each scope's ⋯ menu and New chat
// label, pins and folds groups, opens another Project's chat and follows its live updates. The group order survives a restart (a page reload). No agent calls.
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
const chat = (id, body) => ({
  sessions: { [id]: { id, worktree_id: 1, agent_name: "Claude", status: "Idle", summary: { count: 1, firstId: id, lastId: id, titleLine: body, lastAt: Date.now() - 5 * 60000 } } },
  worktrees: { 1: { id: 1, name: "main", path: "/work/x", diff: { added: 12, removed: 3, files: 2 } } },
  messages: [{ id, session_id: id, role: "user", body }],
});
const listeners = [];
let namedLinks = [{ id: "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7", name: "Checkout", projectIds: ["p-shop", "p-api"] }];
// The restart check sets the recent list's order in sessionStorage (it survives a reload) before it reloads the page.
const restartRecent = JSON.parse(sessionStorage.getItem("restartRecent") ?? "null");
let recent = restartRecent
  ? restartRecent.map((path) => ({ path, name: path.split("/").at(-1), hidden: path === "/work/api" }))
  : [
      { path: "/work/arketa", name: "arketa" },
      { path: "/work/shop", name: "shop" },
      { path: "/work/api", name: "api", hidden: true },
    ];
window.milagre = {
  listRecentProjects: async () => recent,
  forgetProject: async (path) => {
    window.forgetCalls = [...(window.forgetCalls ?? []), path];
    if (window.failForget) throw new Error("Could not save Projects list");
    recent = recent.filter((project) => project.path !== path);
    return recent;
  },
  setProjectHidden: async (path, hidden) => {
    window.hiddenCalls = [...(window.hiddenCalls ?? []), [path, hidden]];
    recent = recent.map((project) => (project.path === path ? { ...project, hidden } : project));
    return recent;
  },
  listProjects: async () => [{ id: "p-shop", path: "/work/shop", name: "shop" }, { id: "p-api", path: "/work/api", name: "api" }],
  listNamedLinks: async () => namedLinks,
  updateNamedLink: async (request) => {
    window.linkHiddenCalls = [...(window.linkHiddenCalls ?? []), request];
    namedLinks = namedLinks.map((link) => link.id === request.id ? { ...link, ...request } : link);
    return namedLinks.find((link) => link.id === request.id);
  },
  getProjectImage: async () => null,
  listEditors: async () => [],
  readProject: async (path) => ({ path, name: path, state: chat(7, "Shop chat") }),
  readLink: async (id) => ({
    link: { id },
    state: {
      next_id: 4,
      sessions: { 3: { id: 3, agent_name: "Checkout", status: "Idle", workspacePath: "/w", worktrees: [{}, {}] } },
      messages: [{ id: 3, session_id: 3, role: "user", body: "Shared checkout chat" }],
      preparations: {},
    },
  }),
  onProjectState: (callback) => (listeners.push(callback), () => {}),
  onLinkState: () => () => {},
  patchChat: async (scope, id, patch) => {
    window.patched = [scope, id, patch];
    if (scope === "/work/shop") window.pushShop({ ...chat(7, "Shop chat"), sessions: { 7: { id: 7, worktree_id: 1, agent_name: "Claude", status: "Idle", ...patch } } });
  },
};
window.addEventListener("milagre:project-removed", (event) => { window.removedProject = event.detail; });
window.pushShop = (state) => listeners.forEach((callback) => callback({ path: "/work/shop", state }));
localStorage.removeItem("milagre.sidebarClosedScopes");
// A restart keeps the saved group order; a first load starts clean.
if (!restartRecent) localStorage.removeItem("milagre.sidebarScopeOrder");
updateSettings({ chatRowShow: DESKTOP_CHAT_ROW_SHOW, chatList: "grouped" });
// Chats the App marks as archiving, set from the check.
function Root() {
  const [archivingChats, setArchivingChats] = React.useState(() => new Set());
  window.setArchiving = (keys) => setArchivingChats(new Set(keys));
  return (
  <div style={{ display: "flex", height: "100vh", padding: "60px 12px 12px" }}>
    <SidebarNav fill workspaceName="arketa" projectPath="/work/arketa" recents={[{ id: "1", label: "Fix the login flow", details: { failed: true } }]} activeId="1"
      runningKeys={"/work/shop#7\\nmilagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7#3"} waitingKeys="milagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7#3" attentionPaths={["/work/shop"]} onOpenScopeChat={(key, id) => { window.opened = key + "#" + id; }}
      onScopeArchiveCheck={async (key, id) => { window.archiveChecked = [key, id]; return { milagreOwned: false, shared: false, status: null }; }}
      onScopeArchive={async (key, id, mode) => { window.archived = [key, id, mode]; }} archivingChats={archivingChats} />
  </div>
  );
}
createRoot(document.getElementById("root")).render(<Root />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 640, show: false, webPreferences: { backgroundThrottling: false } });
  // A page error names the script that threw it, not only "Script failed to execute".
  const evaluate = async (source) => {
    try {
      return await window.webContents.executeJavaScript(source);
    } catch (error) {
      throw new Error(`${error.message}\n  in: ${source.replace(/\s+/g, " ").slice(0, 220)}`, { cause: error });
    }
  };
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
  const click = async (selector) => {
    const point = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await delay(200);
  };
  // Other checks share this storage: leave the sidebar as they expect it.
  const reset = () =>
    evaluate(
      `localStorage.removeItem("milagre.sidebarClosedScopes"); localStorage.removeItem("milagre.sidebarScopeOrder"); sessionStorage.removeItem("restartRecent")`,
    ).catch(() => {});
  const scopes = () => evaluate(`[...document.querySelectorAll("[data-sidebar-scope]")].map((node) => node.dataset.sidebarScope)`);
  // A folded group keeps its rows mounted (inert, zero height) so it can animate shut; they don't count as shown.
  const chats = (scope) =>
    evaluate(
      `[...document.querySelectorAll('[data-sidebar-scope="${scope}"] [data-chat-id]')].filter((node) => !node.closest("[inert]")).map((node) => node.textContent.trim())`,
    );
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="milagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7"] [data-chat-id]')`);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id]')`);
    assert.deepEqual(
      await scopes(),
      ["/work/arketa", "/work/shop", "milagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7"],
      "Every Project and Link but the hidden one",
    );
    assert.match((await chats("/work/arketa"))[0], /Fix the login flow/);
    assert.equal(
      await evaluate(`(() => {
      const dot = document.querySelector('[data-sidebar-scope="/work/arketa"] [data-chat-id="1"] [data-slot="chat-mark"]');
      const expected = document.createElement('span');
      expected.style.color = 'var(--red)';
      document.body.append(expected);
      const matches = dot?.getAttribute('aria-label') === 'Last turn failed' && getComputedStyle(dot).backgroundColor === getComputedStyle(expected).color;
      expected.remove();
      return matches;
    })()`),
      true,
      "Failed Chats have a red status with an accessible label, as on mobile",
    );
    assert.match((await chats("/work/shop"))[0], /Shop chat/);
    assert.equal(
      await evaluate(`(() => {
        const arc = document.querySelector('[data-sidebar-scope="/work/shop"] [data-mark="running"] circle:last-child');
        const expected = document.createElement('span');
        expected.style.color = 'var(--accent)';
        document.body.append(expected);
        const matches = !!arc && getComputedStyle(arc).stroke === getComputedStyle(expected).color;
        expected.remove();
        return matches;
      })()`),
      true,
      "Running Chats use the accent color, as on mobile",
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[data-sidebar-scope="milagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7"] [data-chat-id="3"] [data-mark]')?.dataset.mark`,
      ),
      "waiting",
      "A Link chat waiting on the user shows the mark",
    );
    assert.match((await chats("milagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7"))[0], /Shared checkout chat/);
    assert.equal(
      await evaluate(`(() => {
        const header = document.querySelector('[data-sidebar-scope="milagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7"] [data-scope-toggle]');
        const avatars = [...header.querySelectorAll('[aria-hidden] > span')].map((node) => node.getBoundingClientRect());
        const project = document.querySelector('[data-sidebar-scope="/work/shop"] [data-scope-toggle] span span').getBoundingClientRect();
        return avatars.length === 2 && Math.abs(Math.min(...avatars.map((rect) => rect.left)) - project.left) < 0.5 &&
          Math.max(...avatars.map((rect) => rect.right)) <= header.querySelector('[data-scope-name]').getBoundingClientRect().left;
      })()`),
      true,
      "A Link's stacked avatars start on the Projects' icon line and end before its name",
    );
    await screenshot("all-projects");

    // A waiting group's dot rests at the row's right edge and slides left of the actions that hover reveals.
    const dot = `document.querySelector('[data-sidebar-scope="/work/shop"] [aria-label="Needs attention"]')`;
    const dotGap = () =>
      evaluate(`(() => {
        const row = ${dot}.parentElement.getBoundingClientRect();
        return Math.round(row.right - ${dot}.getBoundingClientRect().right);
      })()`);
    assert.equal(await dotGap(), 12, "At rest the dot sits at the row's right edge");
    const toggle = await evaluate(
      `(() => { const r = document.querySelector('[data-sidebar-scope="/work/shop"] [data-scope-toggle]').getBoundingClientRect(); return { x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    // A slow runner coalesces moves and updates :hover late (CI failed here with the dot still at 12), so the move is
    // sent again until the dot has slid over; the slide itself takes 150 ms.
    for (let attempt = 0; (await dotGap()) !== 64; attempt++) {
      if (attempt === 20) break;
      window.webContents.sendInputEvent({ type: "mouseMove", ...toggle });
      await delay(250);
    }
    assert.equal(await dotGap(), 64, "On hover it moves left of the menu and New chat buttons");
    await screenshot("attention-hover");
    window.webContents.sendInputEvent({ type: "mouseMove", x: 900, y: 400 });
    await delay(300);

    // Every Project offers removal, including the open one.
    assert.equal(await evaluate(`document.querySelectorAll("[data-sidebar-scope][data-current]").length`), 1, "Exactly one scope is open");
    assert.equal(await evaluate(`document.querySelector('[data-sidebar-scope="/work/arketa"]')?.hasAttribute("data-current")`), true);
    assert.equal(await evaluate(`document.querySelector('[data-sidebar-scope="/work/arketa"] [data-scope-action]')?.getAttribute("aria-label")`), "New chat");
    assert.equal(
      await evaluate(`document.querySelector('[data-sidebar-scope="/work/shop"] [data-scope-action]')?.getAttribute("aria-label")`),
      "New chat in shop",
    );

    await evaluate(`document.querySelector('[data-sidebar-scope="/work/shop"] [data-scope-menu]').click()`);
    await waitFor(`!!document.querySelector("[data-scope-menu-panel]")`);
    assert.equal(
      await evaluate(`!!document.querySelector('[data-scope-menu-panel] [data-scope-menu-item="remove"]')`),
      true,
      "A non-current Project's menu offers Remove",
    );
    await screenshot("scope-menu");
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(`!document.querySelector("[data-scope-menu-panel]")`);

    await evaluate(`document.querySelector('[data-sidebar-scope="/work/arketa"] [data-scope-menu]').click()`);
    await waitFor(`!!document.querySelector("[data-scope-menu-panel]")`);
    assert.equal(
      await evaluate(`!!document.querySelector('[data-scope-menu-panel] [data-scope-menu-item="remove"]')`),
      true,
      "The open Project's menu offers Remove",
    );
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(`!document.querySelector("[data-scope-menu-panel]")`);

    // Confirmation is cancellable, and a failed save keeps the dialog open with a retry.
    await evaluate(`document.querySelector('[data-sidebar-scope="/work/arketa"] [data-scope-menu]').click()`);
    await waitFor(`!!document.querySelector('[data-scope-menu-item="remove"]')`);
    await evaluate(`document.querySelector('[data-scope-menu-item="remove"]').click()`);
    await waitFor(`!!document.querySelector('[data-project-remove-confirm]')`);
    assert.equal(await evaluate(`document.activeElement.textContent`), "Cancel");
    await screenshot("remove-project-confirmation");
    await evaluate(`document.activeElement.click()`);
    await waitFor(`!document.querySelector('[data-project-remove-confirm]')`);
    assert.equal(await evaluate(`(window.forgetCalls ?? []).length`), 0);
    await evaluate(`document.querySelector('[data-sidebar-scope="/work/arketa"] [data-scope-menu]').click()`);
    await waitFor(`!!document.querySelector('[data-scope-menu-item="remove"]')`);
    await evaluate(`document.querySelector('[data-scope-menu-item="remove"]').click()`);
    await waitFor(`!!document.querySelector('[data-project-remove-confirm]')`);
    await evaluate(`window.failForget = true; document.querySelector('[data-project-remove-confirm]').click()`);
    await waitFor(`!!document.querySelector('dialog [role="alert"]')`);
    assert.match(await evaluate(`document.querySelector('dialog [role="alert"]').textContent`), /Could not save Projects list/);
    assert.equal(await evaluate(`window.removedProject ?? null`), null);
    await evaluate(`window.failForget = false; document.querySelector('[data-project-remove-confirm]').click()`);
    await waitFor(`!document.querySelector('[data-project-remove-confirm]')`);
    assert.equal(await evaluate(`window.removedProject`), "/work/arketa");
    // The fixture keeps the current Project prop; App closes it in response to the removal event.

    // The project chooser lists every Project, the hidden one unchecked; checking it brings its group back, unchecking hides it again.
    await evaluate(`document.querySelector("[data-filters]").click()`);
    await waitFor(`!!document.querySelector('[data-filters-panel] [data-sub="projects"]')`);
    await evaluate(`document.querySelector('[data-filters-panel] [data-sub="projects"]').click()`);
    await waitFor(`!!document.querySelector('[data-filters-sub="projects"]')`);
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll("[data-project-choice]")].map((row) => [row.dataset.projectChoice, row.getAttribute("aria-checked")])`),
      [
        ["/work/api", "false"],
        ["/work/arketa", "true"],
        ["milagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7", "true"],
        ["/work/shop", "true"],
      ],
      "Every Project by name, the hidden one unchecked",
    );
    await screenshot("project-chooser");
    const linkKey = "milagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
    await evaluate(`document.querySelector('[data-project-choice="${linkKey}"]').click()`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="${linkKey}"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-project-choice="${linkKey}"]').getAttribute("aria-checked")`), "false");
    await screenshot("link-filter-hidden");
    await evaluate(`document.querySelector('[data-project-choice="${linkKey}"]').click()`);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="${linkKey}"] [data-chat-id]')`);
    assert.equal(await evaluate(`document.querySelector('[data-project-choice="${linkKey}"]').getAttribute("aria-checked")`), "true");
    assert.deepEqual(await evaluate("window.linkHiddenCalls"), [
      { id: "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7", name: "Checkout", projectIds: ["p-shop", "p-api"], hidden: true },
      { id: "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7", name: "Checkout", projectIds: ["p-shop", "p-api"], hidden: false },
    ]);
    await screenshot("link-filter-shown");
    await evaluate(`document.querySelector('[data-project-choice="/work/api"]').click()`);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="/work/api"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-project-choice="/work/api"]').getAttribute("aria-checked")`), "true", "The panel stays open");
    await screenshot("project-chooser-checked");
    await evaluate(`document.querySelector('[data-project-choice="/work/shop"]').click()`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="/work/shop"]')`);
    assert.deepEqual(await evaluate("window.hiddenCalls"), [
      ["/work/api", false],
      ["/work/shop", true],
    ]);
    await evaluate(`document.querySelector('[data-project-choice="/work/shop"]').click()`);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="/work/shop"]')`);
    await evaluate(`document.querySelector('[data-project-choice="/work/api"]').click()`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="/work/api"]')`);
    // Escape leaves Projects for the menu, and again closes it.
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(`!document.querySelector("[data-filters-sub]") && document.activeElement?.dataset.sub === "projects"`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(`!document.querySelector("[data-filters-panel]")`);

    await click('[data-sidebar-scope="/work/shop"] [data-chat-id] [data-row]');
    assert.equal(await evaluate("window.opened"), "/work/shop#7", "Another Project's chat opens through onOpenScopeChat");

    // Delete acts on one click against the row's Project, without a confirmation surface.
    await evaluate(`document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id="7"] [aria-label="Chat actions"]').click()`);
    await waitFor(`!!document.querySelector("[data-chat-menu]")`);
    const deleteRow = `[...document.querySelectorAll("[data-chat-menu] [data-menu-row]")].find((row) => row.textContent.trim() === "Delete")`;
    await waitFor(`!!${deleteRow} && !${deleteRow}.disabled`);
    assert.deepEqual(await evaluate("window.archiveChecked"), ["/work/shop", "7"]);
    await evaluate(`${deleteRow}.click()`);
    await waitFor(`!!window.archived`);
    assert.deepEqual(await evaluate("window.archived"), ["/work/shop", "7", "hide"]);
    await waitFor(`!document.querySelector("[data-chat-menu]")`);
    assert.equal(await evaluate('!!document.querySelector("[data-archive-choice], [data-archive-reason]")'), false);
    // While deletion is under way the row is gone; it comes back if deletion fails.
    await evaluate(`window.setArchiving(["/work/shop#7"])`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id="7"]')`);
    await evaluate(`window.setArchiving([])`);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id="7"]')`);

    // Another Project's chat pins from its row menu and moves to the Pinned section on top of every group.
    await evaluate(`document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id="7"] [aria-label="Chat actions"]').click()`);
    await waitFor(`!!document.querySelector("[data-chat-menu]")`);
    await evaluate(`[...document.querySelectorAll("[data-chat-menu] [data-menu-row]")].find((row) => row.textContent.trim() === "Pin").click()`);
    assert.deepEqual(await evaluate("window.patched"), ["/work/shop", 7, { pinned: true, pin_order: 0 }]);
    await waitFor(`!!document.querySelector('[data-all-pinned] [data-pinned-scope="/work/shop"] [data-chat-id="7"]')`);
    assert.equal(
      await evaluate(
        `document.querySelector("[data-all-pinned]").compareDocumentPosition(document.querySelector('[data-sidebar-scope]')) & Node.DOCUMENT_POSITION_FOLLOWING`,
      ),
      4,
      "Pinned comes before the first group",
    );
    assert.deepEqual(await chats("/work/shop"), [], "The pinned chat leaves its group");
    await screenshot("pinned-other-project");

    await evaluate(
      `window.pushShop({ sessions: { 7: { id: 7, worktree_id: 1, agent_name: "Claude", status: "Idle", pinned: true, pin_order: 0 }, 8: { id: 8, worktree_id: 1, agent_name: "Claude", status: "Idle", summary: { count: 1, firstId: 8, lastId: 8, titleLine: "New from the phone", lastAt: Date.now() - 5 * 60000 } } }, worktrees: { 1: { id: 1, name: "main", path: "/work/x", diff: { added: 12, removed: 3, files: 2 } } }, messages: [{ id: 7, session_id: 7, role: "user", body: "Shop chat" }, { id: 8, session_id: 8, role: "user", body: "New from the phone" }] })`,
    );
    await waitFor(`document.querySelectorAll('[data-sidebar-scope="/work/shop"] [data-chat-id]').length === 1`);

    await click('[data-sidebar-scope="/work/shop"] [data-scope-toggle]');
    assert.deepEqual(await chats("/work/shop"), [], "Folding a group hides its chats");
    assert.equal(await evaluate(`!!document.querySelector('[data-all-pinned] [data-chat-id="7"]')`), true, "Its pinned chat stays on top");
    assert.deepEqual(JSON.parse(await evaluate(`localStorage.getItem("milagre.sidebarClosedScopes")`)), ["/work/shop"]);
    await screenshot("folded");

    // Filters › Show adds the branch, the diff and the last activity to each row's second line, and takes them off again.
    const line = () => evaluate(`document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id] [data-chat-prs]')?.textContent.trim() ?? ""`);
    assert.equal(await line(), "", "By default a row without chips has one line");
    await evaluate(`document.querySelector("[data-filters]").click()`);
    await waitFor(`!!document.querySelector('[data-filters-panel] [data-sub="show"]')`);
    await evaluate(`document.querySelector('[data-filters-panel] [data-sub="show"]').click()`);
    await waitFor(`!!document.querySelector('[data-filters-sub="show"]')`);
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll("[data-show-field]")].map((row) => [row.dataset.showField, row.getAttribute("aria-checked")])`),
      [
        ["pullRequests", "true"],
        ["linearIssue", "true"],
        ["branch", "false"],
        ["diff", "false"],
        ["lastActivity", "false"],
      ],
      "This Mac alone: no Computer choice",
    );
    for (const field of ["branch", "diff", "lastActivity"]) await evaluate(`document.querySelector('[data-show-field="${field}"]').click()`);
    await waitFor(`!!document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id] [data-chat-ago]')`);
    assert.match(await line(), /^main\s*·\s*\+12 −3\s*·\s*[45]m$/);
    await screenshot("filters-show");
    await evaluate(`document.querySelector('[data-show-field="diff"]').click()`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-diff]')`);
    for (const field of ["branch", "lastActivity"]) await evaluate(`document.querySelector('[data-show-field="${field}"]').click()`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="/work/shop"] [data-chat-id] [data-chat-prs]')`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(`!document.querySelector("[data-filters-panel]")`);

    // Dragging another Project's chat from its group into Pinned pins it there: the group and its pinned rows are one list.
    const scopeToggle = '[data-sidebar-scope="/work/shop"] [data-scope-toggle]';
    const row8 = '[data-sidebar-scope="/work/shop"] [data-chat-id="8"]';
    const row7 = '[data-all-pinned] [data-pinned-scope="/work/shop"] [data-chat-id="7"]';
    const expanded = () => evaluate(`document.querySelector(${JSON.stringify(scopeToggle)}).getAttribute("aria-expanded")`);
    // Both rows' boxes, or "null" while either is missing: the pinned row comes and goes as the group unfolds.
    const rects = () =>
      evaluate(
        `JSON.stringify([${JSON.stringify(row8)}, ${JSON.stringify(row7)}].map((selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null))`,
      );
    // Unfold the group, reading the toggle rather than assuming the fold above has landed, and press only once both
    // rows have kept the same boxes for half a second: on the CI runner the row was there 100 ms after the unfold,
    // gone again right after (the list mounts once more as the unfold ends), and back by 250 ms.
    for (let attempt = 0; ; attempt++) {
      if ((await expanded()) !== "true") await click(scopeToggle);
      await waitFor(`document.querySelector(${JSON.stringify(row8)})?.getBoundingClientRect().height > 0`);
      let last = await rects();
      let unchanged = 0;
      for (let i = 0; i < 40 && unchanged < 5; i++) {
        await delay(100);
        const next = await rects();
        unchanged = next === last && !next.includes("null") ? unchanged + 1 : 0;
        last = next;
      }
      if (unchanged === 5) break;
      if (attempt === 3) throw new Error(`the unfolded group never settled: aria-expanded=${await expanded()} rows=${last}`);
    }
    // A row is away for a moment while the list mounts again (a press that ended as a click on it does that too), so a
    // row is measured once it is back, not assumed.
    const centre = async (selector) => {
      await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
      return evaluate(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2), bottom: r.bottom }; })()`,
      );
    };
    const mouse = (type, x, y) => window.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
    const target = () => centre(row7);
    // On the CI runner the press sometimes never became a drag (its timeout dump showed no data-chat-drag with the
    // pointer resting on the right row), so the press is repeated until the page marks the drag as begun.
    const dragging = `document.documentElement.hasAttribute("data-chat-drag")`;
    let from, to;
    for (let attempt = 0; !(await evaluate(dragging)); attempt++) {
      if (attempt === 5) throw new Error("Timed out: the drag never began");
      if (attempt) mouse("mouseUp", from.x, from.y);
      from = await centre(row8);
      to = await target();
      mouse("mouseMove", from.x, from.y);
      mouse("mouseDown", from.x, from.y);
      for (let step = 1; step <= 10; step++) {
        mouse("mouseMove", from.x, Math.round(from.y + ((to.bottom - 4 - from.y) * step) / 10));
        await delay(16);
      }
      // Wait for the drag's first render before judging the press lost: releasing a press whose drag begins a moment
      // later drops it where it stands, which pins the chat and leaves the next attempt without its row.
      for (let i = 0; i < 100 && !(await evaluate(dragging)); i++) await delay(50);
    }
    // A slow runner can process those moves before the drag's first render, so none of them set a target. Nudge at the
    // target, read live, until the drop line shows.
    const dropLine = `!!document.querySelector("[data-drop-line]")`;
    for (let attempt = 0; !(await evaluate(dropLine)); attempt++) {
      if (attempt === 25) {
        await screenshot("drag-timeout");
        const state = await evaluate(`(() => {
          const at = document.elementFromPoint(${from.x}, ${Math.round(to.bottom - 4)});
          const rect = (selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && [r.left, r.top, r.right, r.bottom].map(Math.round); };
          return JSON.stringify({ dragging: document.documentElement.hasAttribute("data-chat-drag"), at: at?.outerHTML.slice(0, 160), row8: rect('[data-sidebar-scope="/work/shop"] [data-chat-id="8"]'), row7: rect('[data-all-pinned] [data-pinned-scope="/work/shop"] [data-chat-id="7"]'), pinned: rect("[data-all-pinned]") });
        })()`);
        throw new Error(`Timed out: ${dropLine} ${state}`);
      }
      const now = await target();
      mouse("mouseMove", now.x + (attempt % 2), now.bottom - 4);
      await delay(200);
    }
    await screenshot("drag-into-pinned");
    const drop = await target();
    mouse("mouseUp", drop.x, drop.bottom - 4);
    await waitFor(`window.patched?.[1] === 8`);
    const [scope, id, patch] = await evaluate("window.patched");
    assert.deepEqual([scope, id, patch.pinned], ["/work/shop", 8, true], "dropped below the pinned chat, another Project's chat is pinned");
    assert.ok(patch.pin_order > 0, "after the pinned one");

    // The group order survives a restart: the page reloads (module state gone, storage kept) with the recent list in a new order.
    const LINK = "milagre-link:6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
    const restart = async (recentPaths, expected, message) => {
      await evaluate(`sessionStorage.setItem("restartRecent", ${JSON.stringify(JSON.stringify(recentPaths))})`);
      await window.loadURL(process.argv[2]);
      await waitFor(`document.querySelectorAll("[data-sidebar-scope]").length === ${expected.length}`);
      await delay(150);
      assert.deepEqual(await scopes(), expected, message);
    };
    const savedOrder = async () => JSON.parse(await evaluate(`localStorage.getItem("milagre.sidebarScopeOrder")`));
    // Start from a known order: nothing saved, recent list arketa then shop.
    await evaluate(`localStorage.removeItem("milagre.sidebarScopeOrder")`);
    await restart(["/work/arketa", "/work/shop", "/work/api"], ["/work/arketa", "/work/shop", LINK], "With nothing saved, the groups follow the recent list");
    assert.deepEqual(await savedOrder(), ["/work/arketa", "/work/shop"], "The order shown is saved");
    await restart(
      ["/work/shop", "/work/arketa", "/work/api"],
      ["/work/arketa", "/work/shop", LINK],
      "After a restart with shop most recent, the groups keep their saved order",
    );
    await screenshot("order-after-restart");
    await restart(
      ["/work/docs", "/work/shop", "/work/arketa", "/work/api"],
      ["/work/docs", "/work/arketa", "/work/shop", LINK],
      "A Project new since the last run goes on top, the rest keep their order",
    );
    assert.deepEqual(await savedOrder(), ["/work/docs", "/work/arketa", "/work/shop"]);
    await restart(["/work/docs", "/work/arketa"], ["/work/docs", "/work/arketa", LINK], "A Project that is gone drops out");
    assert.deepEqual(await savedOrder(), ["/work/docs", "/work/arketa"], "Its place is forgotten");
    await restart(
      ["/work/shop", "/work/docs", "/work/arketa"],
      ["/work/shop", "/work/docs", "/work/arketa", LINK],
      "Back again, it counts as new and goes on top",
    );

    // Another window reorders the groups (same storage). This window's unrelated re-render must not put its old order back,
    // and it follows the other window's change when the storage event arrives.
    const other = ["/work/arketa", "/work/docs", "/work/shop"];
    await evaluate(`localStorage.setItem("milagre.sidebarScopeOrder", ${JSON.stringify(JSON.stringify(other))})`);
    await click('[data-sidebar-scope="/work/docs"] [data-scope-toggle]');
    await delay(200);
    assert.deepEqual(await savedOrder(), other, "A re-render in a stale window leaves the other window's order in storage");
    await evaluate(
      `window.dispatchEvent(new StorageEvent("storage", { key: "milagre.sidebarScopeOrder", newValue: localStorage.getItem("milagre.sidebarScopeOrder") }))`,
    );
    await waitFor(`document.querySelector("[data-sidebar-scope]")?.dataset.sidebarScope === "/work/arketa"`);
    assert.deepEqual(await scopes(), [...other, LINK], "This window adopts the other window's order");
    assert.deepEqual(await savedOrder(), other);

    assert.deepEqual(errors, []);
    await reset();
    console.log(
      "PASS: the sidebar lists each Project and Link with its chats, skips a hidden Project, chooses Projects with checkboxes, marks one open scope, offers New chat and confirmed removal for every Project, pins chats to one Pinned section on top, opens them, marks Link chats waiting on the user, follows live changes, folds groups, and keeps the group order across restarts",
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
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-sidebar-all-projects"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "sidebar-all-projects-fixture",
        resolveId(id) {
          if (id === "/__sidebar-all-projects.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar-all-projects.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__sidebar-all-projects") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__sidebar-all-projects.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(
      require("electron"),
      [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar-all-projects`],
      {
        env,
        stdio: "inherit",
      },
    );
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
