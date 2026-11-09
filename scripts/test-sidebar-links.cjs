// Browser check: canvas Links in the sidebar. A chat dropped on another Project's chat offers a Link whose popover
// chooses "Only these Worktrees" or "The whole Projects", can always allow Delegations and can ask the dropped chat
// something; linked rows show a Link icon and the hover card lists what they're linked with; the row menu's
// "Link with…" leads through a filterable chat list to the same popover and "Remove Link with…" removes one, with Undo.
// The bridge is stubbed.
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
let links = [];
const changed = [];
window.calls = { added: [], removed: [], grants: [], asked: [], restored: [] };
const web = {
  sessions: {
    7: { id: 7, worktree_id: 1, agent_name: "Claude", status: "Idle", summary: { count: 1, firstId: 7, lastId: 7, titleLine: "Web login form", lastAt: Date.now() } },
    8: { id: 8, worktree_id: 2, agent_name: "Claude", status: "Idle", summary: { count: 1, firstId: 8, lastId: 8, titleLine: "Web header", lastAt: Date.now() } },
  },
  worktrees: { 1: { id: 1, name: "form", path: "/work/web/.w/form" }, 2: { id: 2, name: "header", path: "/work/web/.w/header" } },
  messages: [
    { id: 7, session_id: 7, role: "user", body: "Web login form" },
    { id: 8, session_id: 8, role: "user", body: "Web header" },
  ],
};
const emit = () => changed.forEach((callback) => callback([...links]));
window.milagre = {
  listRecentProjects: async () => [{ path: "/work/api", name: "api" }, { path: "/work/web", name: "web" }],
  listProjects: async () => [{ id: "p-api", path: "/work/api", name: "api" }, { id: "p-web", path: "/work/web", name: "web" }],
  listNamedLinks: async () => [],
  getProjectImage: async () => null,
  listEditors: async () => [],
  readProject: async (path) => ({ path, name: "web", state: web }),
  onProjectState: () => () => {},
  onLinkState: () => () => {},
  patchChat: async () => {},
  getCanvas: async () => ({ projects: [], links: [...links], worktreePositions: {}, states: [] }),
  getLinks: async () => [...links],
  onLinksChanged: (callback) => (changed.push(callback), () => {}),
  addLink: async (a, b) => {
    window.calls.added.push([a, b]);
    links.push({ id: "l" + window.calls.added.length, a, b, created_at: "" });
    emit();
    return [...links];
  },
  removeLink: async (id) => {
    window.calls.removed.push(id);
    links = links.filter((link) => link.id !== id);
    emit();
    return [...links];
  },
  grantDelegations: async (chatId, linkId) => { window.calls.grants.push([chatId, linkId]); },
  restoreLink: async (link) => {
    window.calls.restored.push(link.id);
    links.push(link);
    emit();
    return [...links];
  },
};
localStorage.removeItem("milagre.sidebarClosedScopes");
updateSettings({ chatRowShow: DESKTOP_CHAT_ROW_SHOW, chatList: "grouped" });
const recents = [
  { id: "1", label: "Alpha login fix", details: { path: "/work/api/.w/alpha", branch: "alpha" } },
  { id: "2", label: "Bravo endpoint", details: { path: "/work/api/.w/bravo", branch: "bravo" } },
  { id: "3", label: "Charlie flaky test", details: { path: "/work/api/.w/charlie", branch: "charlie" } },
];
const actions = { onPin: () => {} };
createRoot(document.getElementById("root")).render(
  <div style={{ display: "flex", height: "100vh", padding: "60px 12px 12px" }}>
    <SidebarNav fill workspaceName="api" projectPath="/work/api" recents={recents} activeId="1" chatActions={actions}
      onAskChat={async (scope, id, message) => { window.calls.asked.push([scope, id, message]); }} />
    <div style={{ flex: 1 }} />
  </div>,
);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1200,
    height: 720,
    show: false,
    webPreferences: { backgroundThrottling: false, partition: "sidebar-links-check" },
  });
  window.webContents.on("did-finish-load", () => window.webContents.setZoomFactor(1));
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const evaluate = async (source) => {
    const result = await window.webContents.executeJavaScript(
      `(async () => { try { return { value: await (${source}) }; } catch (error) { return { error: String(error?.stack ?? error) }; } })()`,
    );
    if ("error" in result) throw new Error(`${result.error}\nExpression: ${source}`);
    return result.value;
  };
  const mouse = (type, x, y, down = true) =>
    window.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1, modifiers: type === "mouseMove" && down ? ["leftButtonDown"] : [] });
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const rowSelector = (scope, id) => `[data-chat-scope="${scope}"] [data-chat-id="${id}"]`;
  const box = (selector) =>
    evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`,
    );
  const calls = () => evaluate("window.calls");
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  const clickSelector = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  // Picks a row up, then moves onto the target row, measured again once the drag shows the Pinned drop area above.
  async function drag(from, toSelector, { release = true } = {}) {
    mouse("mouseMove", from.x, from.y, false);
    mouse("mouseDown", from.x, from.y);
    mouse("mouseMove", from.x, from.y + 8);
    await waitFor('document.documentElement.hasAttribute("data-chat-drag")');
    await delay(100);
    const to = await box(toSelector);
    for (let i = 1; i <= 8; i++) {
      mouse("mouseMove", from.x, Math.round(from.y + ((to.y - from.y) * i) / 8));
      await delay(30);
    }
    await delay(120);
    mouse("mouseMove", to.x, to.y);
    await delay(150);
    if (release) {
      mouse("mouseUp", to.x, to.y);
      await delay(250);
    }
  }
  // Opens a row's ⋯ menu the way a right-click does.
  async function openMenu(scope, id) {
    const point = await box(rowSelector(scope, id));
    window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "right", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "right", clickCount: 1 });
    await waitFor('!!document.querySelector("[data-chat-menu]")');
  }
  const menuItem = (label) =>
    `[...document.querySelectorAll("[data-chat-menu] [data-menu-row]")].find((node) => node.textContent.trim() === ${JSON.stringify(label)})`;
  const screenshot = async (name) => {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await delay(300);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const reset = () => evaluate(`localStorage.removeItem("milagre.sidebarClosedScopes")`).catch(() => {});
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('${rowSelector("/work/web", "7")}') && !!document.querySelector('${rowSelector("/work/api", "3")}')`);
    await delay(300);
    assert.equal(await evaluate('document.querySelectorAll("[data-chat-linked]").length'), 0, "no Links, no icons");

    // Within one Project: the popover joins the two Worktrees and doesn't offer the whole Projects.
    await drag(await box(rowSelector("/work/api", "2")), rowSelector("/work/api", "1"), { release: false });
    await waitFor('document.querySelector("[data-drop-target]")?.dataset.dropTarget === "link"');
    mouse("mouseUp", 0, 0);
    await waitFor('!!document.querySelector("[data-link-popover]")');
    assert.equal(await evaluate('!!document.querySelector("[data-link-scope]")'), false, "one Project: no scope choice");
    await clickSelector("[data-link-confirm]");
    await waitFor('/Link created/.test(document.querySelector("[data-chat-toast]")?.textContent ?? "")');
    assert.deepEqual((await calls()).added[0], [
      { project_id: "p-api", worktree_path: "/work/api/.w/bravo" },
      { project_id: "p-api", worktree_path: "/work/api/.w/alpha" },
    ]);
    assert.deepEqual((await calls()).grants, [], "Always allow is off unless checked");
    assert.deepEqual((await calls()).asked, [], "nothing is sent without a message");

    // Both rows show the Link icon, labelled with the other end.
    await waitFor('document.querySelectorAll("[data-chat-linked]").length === 2');
    assert.match(
      await evaluate(`document.querySelector('${rowSelector("/work/api", "1")} [data-chat-linked]').getAttribute("aria-label")`),
      /Linked to api \/ bravo/,
    );
    await screenshot("row-icons");

    // The hover card lists the linked Worktrees.
    const alpha = await box(rowSelector("/work/api", "1"));
    mouse("mouseMove", alpha.x, alpha.y, false);
    await waitFor('!!document.querySelector("[data-chat-hover-card] [data-chat-card-links]")');
    assert.match(await text("[data-chat-card-links]"), /Linked with\s*api \/ bravo/);
    await screenshot("hover-card");
    mouse("mouseMove", 1000, 600, false);
    await waitFor('!document.querySelector("[data-chat-hover-card]")');

    // The toast leaves after 6 seconds, out of the way of the popover in the screenshots.
    for (let i = 0; i < 40 && (await evaluate('!!document.querySelector("[data-chat-toast]")')); i++) await delay(250);

    // Across Projects: Charlie dropped on the web Project's chat offers the whole Projects too.
    await drag(await box(rowSelector("/work/api", "3")), rowSelector("/work/web", "7"), { release: false });
    await waitFor('document.querySelector("[data-drop-target][data-drop-scope]")?.dataset.dropTarget === "link"');
    await screenshot("cross-project-target");
    mouse("mouseUp", 0, 0);
    await waitFor('!!document.querySelector("[data-link-popover] [data-link-scope]")');
    assert.equal(
      await evaluate('document.querySelector("[data-link-scope-choice=worktrees]").getAttribute("aria-checked")'),
      "true",
      "Only these Worktrees by default",
    );
    await clickSelector("[data-link-scope-choice=projects]");
    await waitFor('/Link these Projects/.test(document.querySelector("[data-link-popover]").textContent)');
    await clickSelector("[data-link-always-allow] input");
    await evaluate(`(() => {
      const field = document.querySelector("[data-link-ask]");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, "Wire the new endpoint into the login form");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor('document.querySelector("[data-link-confirm]").textContent === "Create Link and ask"');
    await screenshot("popover");
    await clickSelector("[data-link-confirm]");
    await waitFor('/Asked “Charlie flaky test”/.test(document.querySelector("[data-chat-toast]")?.textContent ?? "")');
    const after = await calls();
    assert.deepEqual(after.added[1], [{ project_id: "p-api" }, { project_id: "p-web" }], "the whole Projects");
    assert.deepEqual(after.grants, [["/work/api#3", "l2"]], "Always allow is granted for the dropped chat and the new Link");
    assert.equal(after.asked.length, 1);
    assert.equal(after.asked[0][0], "/work/api");
    assert.equal(after.asked[0][1], "3", "the message goes to the dropped chat");
    assert.match(after.asked[0][2].body, /^Wire the new endpoint into the login form\n\nDestination: “Web login form” \(web \/ form\)/);
    assert.match(after.asked[0][2].prompt, /\/work\/web#7/);
    // Every chat of both Projects is now linked.
    await waitFor(`!!document.querySelector('${rowSelector("/work/web", "8")} [data-chat-linked]')`);

    // "Link with…" from the menu: a filterable list, with linked chats shown but not pickable.
    await openMenu("/work/api", "1");
    await screenshot("menu");
    assert.ok(await evaluate(`!!${menuItem("Link with…")}`));
    assert.ok(await evaluate(`!!${menuItem("Remove Link with…")}`));
    await evaluate(`${menuItem("Link with…")}.click()`);
    await waitFor('!!document.querySelector("[data-link-picker=link]")');
    assert.equal(await evaluate("document.activeElement?.matches('[data-link-search]')"), true, "the filter has focus");
    assert.match(await text('[data-link-entry="/work/api#2"]'), /Already linked/);
    assert.match(await text('[data-link-entry="/work/web#7"]'), /Already linked/);
    assert.match(await text('[data-link-entry="/work/web#8"]'), /Already linked/, "linked through the whole Projects");
    assert.equal(
      await evaluate("document.querySelector('[data-link-entry=\"/work/api#3\"]').disabled"),
      false,
      "the Projects' Link doesn't join two Worktrees of one Project",
    );
    await evaluate(`(() => {
      const field = document.querySelector("[data-link-search]");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "header");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor('document.querySelectorAll("[data-link-entry]").length === 1');
    await screenshot("link-with");
    // Nothing pickable is left (the web header is linked through the Projects), so the list says so by disabling it.
    assert.equal(await evaluate('document.querySelector("[data-link-entry]").disabled'), true);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor('!document.querySelector("[data-link-picker]")');

    // "Remove Link with…": the chat's Links by their other end; removing one offers Undo.
    await openMenu("/work/api", "3");
    await evaluate(`${menuItem("Remove Link with…")}.click()`);
    await waitFor('!!document.querySelector("[data-link-picker=remove]")');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-link-entry]")].map((node) => node.textContent.trim())'), ["All of web"]);
    await screenshot("remove-link");
    await clickSelector('[data-link-entry="l2"]');
    await waitFor('/Link removed/.test(document.querySelector("[data-chat-toast]")?.textContent ?? "")');
    assert.deepEqual((await calls()).removed, ["l2"]);
    await waitFor(`!document.querySelector('${rowSelector("/work/web", "7")} [data-chat-linked]')`);
    await clickSelector("[data-chat-toast-undo]");
    await waitFor(`!!document.querySelector('${rowSelector("/work/web", "7")} [data-chat-linked]')`);
    assert.deepEqual((await calls()).restored, ["l2"], "Undo restores the same Link, so its Always allow grant still matches");
    assert.equal((await calls()).added.length, 2, "Undo makes no new Link");

    // Then "Link with…" picks a chat with the keyboard: the filter, Enter, and the popover for that chat.
    await evaluate("window.milagre.removeLink('l2')");
    await openMenu("/work/api", "1");
    await evaluate(`${menuItem("Link with…")}.click()`);
    await waitFor('!!document.querySelector("[data-link-picker=link]")');
    await evaluate(`(() => {
      const field = document.querySelector("[data-link-search]");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "charlie");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor('document.querySelectorAll("[data-link-entry]").length === 1 && !document.querySelector("[data-link-entry]").disabled');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    await waitFor('!!document.querySelector("[data-link-popover]")');
    assert.match(await text("[data-link-sides]"), /alpha.*charlie/);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await waitFor('!document.querySelector("[data-link-popover]")');
    assert.equal((await calls()).added.length, 2, "Escape creates nothing");

    assert.deepEqual(errors, []);
    console.log("PASS: sidebar Links: scope choice, Always allow, Link and ask, row icons, hover card, Link with… and Remove Link with…");
    await reset();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await reset();
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
        name: "sidebar-links-fixture",
        resolveId(id) {
          if (id === "/__sidebar_links_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar_links_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__sidebar_links__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__sidebar_links_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar_links__`], { env, stdio: "inherit" });
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
