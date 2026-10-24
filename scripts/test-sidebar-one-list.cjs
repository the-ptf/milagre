// Browser check: the One list sidebar (the default) shows the pinned Chats under Pinned and every other Chat of every
// Project in one list, latest first, each row naming its Project on its second line; Settings › Chat's Grouped by
// Project brings the Project groups back, and One list takes them away again. The bridge is stubbed; no agent calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

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
  ]),
  "/work/api": state([session(4, "API chat", 30)]),
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
  patchChat: async () => {},
};
localStorage.removeItem("milagre.sidebarClosedScopes");
localStorage.removeItem("milagre-settings");
updateSettings({ chatRowShow: DESKTOP_CHAT_ROW_SHOW });
function Fixture() {
  return (
    <div style={{ display: "flex", gap: 12, height: "100vh", padding: "60px 12px 12px" }}>
      <SidebarNav fill workspaceName="arketa" projectPath="/work/arketa" recents={[{ id: "1", label: "Fix the login flow", details: { lastAt: minutes(60) } }]} activeId="1" />
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section="chat" models={[]} update={null} /></main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const option = (label) =>
  `[...document.querySelectorAll('[role="listbox"][aria-label="Chat list"] [role="option"]')].find((o) => o.textContent.includes(${JSON.stringify(label)}))`;

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
  const trigger = `document.querySelector('button[aria-label="Chat list"]')`;
  const rows = (container) =>
    evaluate(
      `[...document.querySelectorAll(${JSON.stringify(container + " [data-chat-id]")})].map((node) => [node.textContent.trim(), node.querySelector("[data-chat-project]")?.textContent.trim() ?? null])`,
    );
  const choose = async (label) => {
    await evaluate(`${trigger}.click()`);
    await waitFor(`!!${option(label)}`);
    await evaluate(`${option(label)}.click()`);
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`document.querySelectorAll("[data-chat-list-flat] [data-chat-id]").length === 4`);

    assert.equal(await evaluate(`${trigger}.textContent.trim()`), "One list", "Settings › Chat starts on One list");
    assert.equal(await evaluate(`document.querySelectorAll("[data-sidebar-scope]").length`), 0, "No Project groups");
    assert.equal(await evaluate(`document.querySelectorAll("[data-scope-toggle]").length`), 0, "No Project headers to fold");
    assert.equal(await evaluate(`document.querySelectorAll("[data-chat-list-flat]").length`), 1, "One flat list");

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
        const line = row.querySelector("[data-chat-prs]");
        return line && line.firstElementChild.querySelector("[data-chat-project]");
      })`),
      true,
      "The Project is the first item of every second line",
    );
    assert.equal(await evaluate(`!!document.querySelector("[data-one-list-header] button[aria-label='New chat']")`), true, "New chat stays in the list header");
    await screenshot("one-list");

    // Grouped by Project: today's sidebar, a group per Project that folds.
    await choose("Grouped by Project");
    await waitFor(`document.querySelectorAll("[data-sidebar-scope]").length === 3`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll("[data-sidebar-scope]")].map((node) => node.dataset.sidebarScope)`), [
      "/work/arketa",
      "/work/shop",
      "/work/api",
    ]);
    assert.equal(await evaluate(`document.querySelectorAll("[data-chat-list-flat]").length`), 0, "The flat list is gone");
    assert.equal(await evaluate(`document.querySelectorAll("[data-chat-project]").length`), 0, "Rows no longer repeat their Project");
    assert.equal(JSON.parse(await evaluate(`localStorage.getItem("milagre-settings")`)).chatList, "grouped", "Grouped by Project is saved");
    await screenshot("grouped");

    // And back to One list.
    await choose("One list");
    await waitFor(`document.querySelectorAll("[data-chat-list-flat] [data-chat-id]").length === 4`);
    assert.equal(await evaluate(`document.querySelectorAll("[data-sidebar-scope]").length`), 0);
    assert.equal(JSON.parse(await evaluate(`localStorage.getItem("milagre-settings")`)).chatList, "list");

    assert.deepEqual(errors, []);
    console.log(
      "PASS: the One list sidebar shows pinned Chats under Pinned and every other Chat in one latest-first list with its Project leading the second line, and Settings › Chat switches to Project groups and back",
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
          server.middlewares.use(async (request, response, next) => {
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
