// Browser check: the One list sidebar (the default) shows the pinned Chats under Pinned and every other Chat of every
// Project in one list, latest first. Its rows are inbox rows: the Project's icon, the title with its time (a spinner
// while it runs, a dot when unread), and one line naming the Project, what the Chat is doing and its diff, with no
// branch and no ⋯ button (the menu opens on a right-click). Settings › Chat's By Project brings the Project groups back,
// and One list takes them away again. The bridge is stubbed; no agent calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import SidebarNav from "/src/components/SidebarNav";
import { SettingsPanel } from "/src/components/Settings";
import { updateSettings } from "/src/lib/settings";
import { DESKTOP_CHAT_ROW_SHOW } from "@milagre/shared/chat-row";
import "/src/styles.css";
const minutes = (count) => Date.now() - count * 60000;
const session = (id, body, age, extra = {}) => ({ id, worktree_id: 1, agent_name: "Claude", status: "Idle", summary: { count: 1, firstId: id, lastId: id, titleLine: body, lastAt: minutes(age) }, ...extra });
const state = (sessions) => ({
  sessions: Object.fromEntries(sessions.map((one) => [one.id, one])),
  worktrees: { 1: { id: 1, name: "main", path: "/work/x" } },
  messages: sessions.map((one) => ({ id: one.id, session_id: one.id, role: "user", body: one.summary.titleLine })),
});
const states = {
  "/work/shop": state([
    session(7, "Older shop chat", 180),
    session(8, "Shop chat", 5),
    session(9, "Pinned shop chat", 400, { pinned: true, pin_order: 1 }),
    session(6, "Done shop chat", 90, { done_at: minutes(60) }),
  ]),
  "/work/api": state([session(4, "API chat", 30, { unread: true })]),
};
window.milagre = {
  listRecentProjects: async () => [
    { path: "/work/arketa", name: "arketa" },
    { path: "/work/shop", name: "shop" },
    { path: "/work/api", name: "api" },
  ],
  listProjects: async () => [],
  listNamedLinks: async () => [],
  getProjectImage: async () => null,
  listEditors: async () => [],
  readProject: async (path) => ({ path, name: path, state: states[path] }),
  onProjectState: () => () => {},
  onLinkState: () => () => {},
  patchChat: async (...args) => {
    (window.patches ??= []).push(args);
  },
};
localStorage.removeItem("milagre.sidebarClosedScopes");
localStorage.removeItem("milagre-settings");
// Branch on: the One list's rows still never show it.
updateSettings({ chatRowShow: { ...DESKTOP_CHAT_ROW_SHOW, branch: true, lastActivity: true } });
function Fixture() {
  return (
    <div style={{ display: "flex", gap: 12, height: "100vh", padding: "60px 12px 12px" }}>
      <SidebarNav fill workspaceName="arketa" projectPath="/work/arketa" recents={[{ id: "1", label: "Fix the login flow", mark: "running", details: { lastAt: minutes(60), branch: "fix-login", diff: { added: 142, removed: 38 } } }]} activeId="1" />
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section="chat" models={[]} update={null} /></main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const card = (label) => `document.querySelector('[role="radiogroup"][aria-label="Chat list"] [aria-label=${JSON.stringify(label)}]')`;
const row = (id) => `document.querySelector('[data-chat-list-flat] [data-chat-id="${id}"]')`;
const checked = `document.querySelector('[role="radiogroup"][aria-label="Chat list"] [aria-checked="true"]')?.getAttribute("aria-label")`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-one-list-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 640, show: false, webPreferences: { backgroundThrottling: false } });
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
    window.webContents.invalidate();
    await delay(300);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const rows = (container) =>
    evaluate(
      `[...document.querySelectorAll(${JSON.stringify(container + " [data-chat-id]")})].map((node) => [node.querySelector("[data-chat-title]").textContent.trim(), node.querySelector("[data-chat-project]")?.textContent.trim() ?? null])`,
    );
  const choose = async (label) => {
    await evaluate(`${card(label)}.click()`);
    await waitFor(`${checked} === ${JSON.stringify(label)}`);
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`document.querySelectorAll("[data-chat-list-flat] [data-chat-id]").length === 4`);

    assert.equal(await evaluate(checked), "One list", "Settings › Chat starts on One list");
    assert.equal(await evaluate(`document.querySelectorAll("[data-sidebar-scope]").length`), 0, "No Project groups");
    // The Chats group (Chats without a Project) shows only once such a Chat exists; these Projects have none.
    assert.equal(await evaluate(`document.querySelectorAll("[data-sidebar-chats]").length`), 0, "No Chats group without a Chat without a Project");
    assert.equal(await evaluate(`document.querySelectorAll("[data-chats-divider]").length`), 0, "No divider without the Chats group");
    assert.equal(
      await evaluate(`[...document.querySelectorAll("[data-scope-toggle]")].filter((node) => !node.closest("[data-sidebar-chats]")).length`),
      0,
      "No Project headers to fold",
    );
    assert.equal(
      await evaluate(`[...document.querySelectorAll("[data-chat-list-flat]")].filter((node) => !node.closest("[data-sidebar-chats]")).length`),
      1,
      "One flat list",
    );

    // Pinned Chats sit under the shared Pinned header, in their Project's slot.
    await waitFor(`document.querySelectorAll("[data-all-pinned] [data-chat-id]").length === 1`);
    assert.equal(await evaluate(`document.querySelector("[data-all-pinned] p")?.textContent`), "Pinned");
    assert.deepEqual(
      (await rows("[data-all-pinned]")).map(([title, project]) => [title.includes("Pinned shop chat"), project]),
      [[true, "shop"]],
      "The pinned Chat leads, with its Project on its second line",
    );

    // Everything else, latest message first across Projects, each row naming its Project first on the second line.
    const expected = [
      ["Shop chat", "shop"],
      ["API chat", "api"],
      ["Fix the login flow", "arketa"],
      ["Older shop chat", "shop"],
    ];
    const flat = await rows("[data-chat-list-flat]");
    assert.deepEqual(
      flat.map(([, project]) => project),
      expected.map(([, project]) => project),
      "One list: latest activity first, across Projects",
    );
    flat.forEach(([title], index) => assert.ok(title.includes(expected[index][0]), `row ${index} is ${expected[index][0]}, not ${title}`));
    assert.equal(
      await evaluate(`[...document.querySelectorAll("[data-chat-list-flat] [data-chat-id]")].every((row) => {
        const line = row.querySelector("[data-chat-line]");
        return line && line.firstElementChild.querySelector("[data-chat-project]");
      })`),
      true,
      "The Project is the first item of every second line",
    );

    // Inbox rows: the Project's icon on the left, no ⋯ button, no branch, a sans second line.
    const inbox = await evaluate(`[...document.querySelectorAll("[data-chat-list-flat] [data-chat-id], [data-all-pinned] [data-chat-id]")].map((row) => ({
      icon: !!row.querySelector("[data-row] [data-chat-project-icon]"),
      actions: !!row.querySelector('[aria-label="Chat actions"]'),
      branch: !!row.querySelector("[data-chat-branch]"),
      mono: [...row.querySelectorAll("[data-chat-line] *")].some((node) => /mono/i.test(getComputedStyle(node).fontFamily)),
    }))`);
    assert.equal(inbox.length, 5);
    assert.ok(
      inbox.every((row) => row.icon),
      "Every row leads with its Project's icon",
    );
    assert.ok(
      inbox.every((row) => !row.actions),
      "No ⋯ button on One list rows",
    );
    assert.ok(
      inbox.every((row) => !row.branch),
      "No branch on One list rows, even with Branch on",
    );
    assert.ok(
      inbox.every((row) => !row.mono),
      "No monospace on the second line",
    );
    // Running: a spinner where the time goes, and no word for it on the second line.
    assert.equal(await evaluate(`${row(1)}.querySelector("[data-chat-time] [data-mark]")?.dataset.mark`), "running");
    assert.equal(await evaluate(`!!${row(1)}.querySelector("[data-chat-ago]")`), false, "A running row shows its spinner, not its time");
    assert.equal(await evaluate(`!!${row(1)}.querySelector("[data-chat-status]")`), false, "The second line says no state");
    // Done: out of the list, in the folded Done section at the bottom, which opens to a countdown and Reopen.
    assert.equal(await evaluate(`!!${row(6)}`), false, "A Done Chat leaves the list");
    assert.equal(await evaluate(`document.querySelector("[data-done-count]")?.textContent`), "1");
    assert.equal(await evaluate(`!!document.querySelector('[data-done-row="6"]')`), false, "The Done section starts folded");
    await evaluate(`document.querySelector("[data-done-toggle]").click()`);
    await waitFor(`!!document.querySelector('[data-done-row="6"]')`);
    await screenshot("one-list-done-open");
    assert.match(await evaluate(`document.querySelector('[data-done-row="6"] [data-done-countdown]').textContent`), /^2[23]:\d\d$/);
    await evaluate(`document.querySelector('[data-done-row="6"] [data-done-reopen]').click()`);
    assert.deepEqual(await evaluate(`window.patches.at(-1)`), ["/work/shop", 6, { done: false }]);
    // Reopen moves the row back at once, before its host answers (this stub host never does).
    await waitFor(`!!${row(6)} && !document.querySelector('[data-done-row="6"]')`);
    // The hover Done button marks a Chat Done at once, with an Undo toast; the row moves before its host answers.
    assert.equal(await evaluate(`!!${row(7)}.querySelector("[data-chat-done]")`), true);
    await evaluate(`${row(7)}.querySelector("[data-chat-done]").click()`);
    assert.deepEqual(await evaluate(`window.patches.at(-1)`), ["/work/shop", 7, { done: true, unread: false }]);
    await waitFor(`!${row(7)} && !!document.querySelector('[data-done-row="7"]')`);
    await waitFor(`[...document.querySelectorAll("[role=status], [data-chat-toast]")].some((node) => node.textContent.includes("Moved to Done"))`);
    // The toast sits inside the sidebar, just above its bottom bar, not beside it.
    assert.equal(
      await evaluate(`(() => {
        const toast = document.querySelector("[data-chat-toast]").getBoundingClientRect();
        const aside = document.querySelector("aside").getBoundingClientRect();
        return toast.left >= aside.left && toast.right <= aside.right && toast.bottom <= aside.bottom;
      })()`),
      true,
      "the toast sits inside the sidebar",
    );
    await screenshot("one-list-done-toast");
    // ⌘Z (Ctrl+Z off a Mac) takes the Done back from anywhere outside a field, and ⇧⌘Z does it again.
    const undoKey = (shift) =>
      evaluate(`(() => {
        const mac = /Mac/.test(navigator.userAgent);
        const init = { key: ${JSON.stringify(shift ? "Z" : "z")}, shiftKey: ${shift}, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true };
        return document.body.dispatchEvent(new KeyboardEvent("keydown", init));
      })()`);
    await undoKey(false);
    assert.deepEqual(await evaluate(`window.patches.at(-1)`), ["/work/shop", 7, { done: false }]);
    await waitFor(`!!${row(7)} && document.querySelector("[data-chat-toast]")?.textContent.includes("Back in Chats")`);
    assert.equal(await evaluate(`!!document.querySelector("[data-chat-toast-redo]")`), true, "the undone toast offers Redo");
    await undoKey(true);
    assert.deepEqual(await evaluate(`window.patches.at(-1)`), ["/work/shop", 7, { done: true, unread: false }]);
    await waitFor(`!${row(7)} && document.querySelector("[data-chat-toast]")?.textContent.includes("Moved to Done")`);
    // Diff stats are off by default; the branch is on but never shows here.
    assert.equal(await evaluate(`!!${row(1)}.querySelector("[data-chat-diff]")`), false);
    assert.equal(await evaluate(`${row(1)}.textContent.includes("fix-login")`), false, "No branch name on the row");
    // Unread: the time in the accent, bold, and a dot after it; the title bold.
    assert.equal(await evaluate(`${row(4)}.querySelector("[data-chat-ago]")?.textContent`), "30m");
    assert.equal(await evaluate(`${row(4)}.querySelector("[data-chat-ago]").className.includes("text-accent")`), true);
    assert.equal(await evaluate(`!!${row(4)}.querySelector('[data-chat-time] [data-mark="unread"]')`), true, "The unread dot follows the time");
    assert.equal(await evaluate(`getComputedStyle(${row(4)}.querySelector("[data-chat-title]").parentElement).fontWeight`), "600");
    assert.equal(await evaluate(`getComputedStyle(${row(8)}.querySelector("[data-chat-title]").parentElement).fontWeight`), "500");
    // Pinned: a pin before the title.
    assert.equal(await evaluate(`!!document.querySelector('[data-all-pinned] [data-chat-id="9"] [data-chat-pinned]')`), true, "Pinned rows show a pin");
    // The menu opens on a right-click and from the keyboard.
    await evaluate(
      `(() => { const r = ${row(8)}.querySelector("[data-row]").getBoundingClientRect(); ${row(8)}.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 })); })()`,
    );
    await waitFor(`!!document.querySelector("[data-chat-menu]")`);
    await evaluate(`document.querySelector("[data-chat-menu]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(`!document.querySelector("[data-chat-menu]")`);
    await evaluate(
      `${row(8)}.querySelector("[data-row]").focus(); ${row(8)}.querySelector("[data-row]").dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }))`,
    );
    await waitFor(`!!document.querySelector("[data-chat-menu]")`);
    await evaluate(`document.querySelector("[data-chat-menu]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(`!document.querySelector("[data-chat-menu]")`);
    assert.equal(await evaluate(`!!document.querySelector("[data-one-list-header] button[aria-label='New chat']")`), true, "New chat stays in the list header");
    await screenshot("one-list");

    // Grouped by Project: today's sidebar, a group per Project that folds.
    await choose("By Project");
    await waitFor(`document.querySelectorAll("[data-sidebar-scope]").length === 3`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll("[data-sidebar-scope]")].map((node) => node.dataset.sidebarScope)`), [
      "/work/arketa",
      "/work/shop",
      "/work/api",
    ]);
    assert.equal(
      await evaluate(`[...document.querySelectorAll("[data-chat-list-flat]")].filter((node) => !node.closest("[data-sidebar-chats]")).length`),
      0,
      "The flat list is gone",
    );
    assert.equal(await evaluate(`document.querySelectorAll("[data-chat-project]").length`), 0, "Rows no longer repeat their Project");
    assert.equal(await evaluate(`document.querySelectorAll("[data-inbox-row]").length`), 0, "Grouped rows keep their own look");
    assert.equal(JSON.parse(await evaluate(`localStorage.getItem("milagre-settings")`)).chatList, "grouped", "Grouped by Project is saved");
    await screenshot("grouped");

    // And back to One list.
    await choose("One list");
    await waitFor(`document.querySelectorAll("[data-chat-list-flat] [data-chat-id]").length === 4`);
    assert.equal(await evaluate(`document.querySelectorAll("[data-sidebar-scope]").length`), 0);
    assert.equal(JSON.parse(await evaluate(`localStorage.getItem("milagre-settings")`)).chatList, "list");

    assert.deepEqual(errors, []);
    console.log(
      "PASS: the One list sidebar shows pinned Chats under Pinned and every other Chat in one latest-first list of inbox rows (Project icon, title with time, spinner or unread dot, Project leading the second line, no branch or ⋯ button, menu on right-click and Shift-F10), and Settings › Chat switches to Project groups and back",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    await screenshot("failure").catch(() => {});
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-sidebar-one-list"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "sidebar-one-list-fixture",
        resolveId(id) {
          if (id === "/__sidebar-one-list.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar-one-list.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__sidebar-one-list") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__sidebar-one-list.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar-one-list`], {
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
