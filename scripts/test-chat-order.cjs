// Browser check: the sidebar keeps chats in start order by default, and Settings switches it to latest message first.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import SidebarNav from "/src/components/SidebarNav";
import { SettingsPanel } from "/src/components/Settings";
import { orderChats } from "/src/lib/chat-list";
import { useSettings } from "/src/lib/settings";
import { MODEL_CATALOG } from "/src/model";
import "/src/styles.css";
// The sidebar lists the open Project's group from these recents.
window.milagre = {
  listRecentProjects: async () => [{ path: "/work/agent-sessions-pr2", name: "agent-sessions-pr2" }],
  readProject: async (path) => ({ path, name: path, state: { sessions: {}, worktrees: {}, messages: [] } }),
  listProjects: async () => [], listNamedLinks: async () => [], getProjectImage: async () => null,
  listEditors: async () => [],
};
// Message ids: the first dates the chat's start, the last its latest reply.
const chats = [
  { id: "1", label: "the chat names arent reflecting the first message", ids: [1, 40] },
  { id: "2", label: "if a session creates multiple worktrees", ids: [10, 12] },
  { id: "3", label: "lets start creating a diff viewer", ids: [20, 30] },
  { id: "4", label: "currently the chats are reordering", ids: [35, 36] },
].map((chat) => ({ ...chat, session: {}, sessionMessages: chat.ids.map((id) => ({ id })) }));
function Fixture() {
  const { chatOrder } = useSettings();
  const recents = orderChats(chats, chatOrder).map(({ id, label }) => ({ id, label }));
  return (
    <div style={{ display: "flex", height: "100vh", padding: "60px 12px 12px", gap: 24 }}>
      <SidebarNav fill workspaceName="agent-sessions-pr2" projectPath="/work/agent-sessions-pr2" recents={recents} activeId="4" />
      <div style={{ flex: 1, overflow: "auto" }}><SettingsPanel section="general" models={MODEL_CATALOG} /></div>
    </div>
  );
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 760, show: false, webPreferences: { backgroundThrottling: false, partition: "chat-order-check" } });
  window.webContents.on("did-finish-load", () => window.webContents.setZoomFactor(1));
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  // The chats' keywords in the order they read in the sidebar.
  const order = () =>
    evaluate(
      '(() => { const text = document.querySelector("aside").innerText; return ["chat names", "worktrees", "diff viewer", "reordering"].sort((a, b) => text.indexOf(a) - text.indexOf(b)); })()',
    );
  const screenshot = async (name) => {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await evaluate('document.querySelector("[aria-label=\\"Chat order\\"]").scrollIntoView({ block: "center" })');
    await delay(200);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await evaluate('localStorage.removeItem("milagre-settings")');
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[aria-label=\\"Chat order\\"]")');
    await delay(400);
    assert.deepEqual(await order(), ["reordering", "diff viewer", "worktrees", "chat names"], "newest chat first by default");
    assert.match(await evaluate('document.querySelector("button[aria-label=\\"Chat order\\"]").textContent'), /Newest chat first/);
    await screenshot("newest-chat-first");
    await evaluate('document.querySelector("button[aria-label=\\"Chat order\\"]").click()');
    await waitFor('!!document.querySelector("[role=listbox][aria-label=\\"Chat order\\"]")');
    await delay(300);
    await screenshot("picker");
    await evaluate('[...document.querySelectorAll("[role=option]")].find(n => n.textContent.includes("Latest message first")).click()');
    await delay(400);
    assert.deepEqual(await order(), ["chat names", "reordering", "diff viewer", "worktrees"], "latest message first once chosen");
    assert.equal(JSON.parse(await evaluate('localStorage.getItem("milagre-settings")')).chatOrder, "recent");
    await screenshot("latest-message-first");
    console.log("PASS: newest chat first by default, Settings switches to latest message first and saves it");
    app.exit(0);
  } catch (error) {
    console.error(error);
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
        name: "chat-order-fixture",
        resolveId(id) {
          if (id === "/__chat_order_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_order_fixture.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__chat_order__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__chat_order_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat_order__`], { env, stdio: "inherit" });
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
