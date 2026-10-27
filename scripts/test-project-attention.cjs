// Browser check: another project's waiting chat dots its group in the sidebar, and the top-right
// "Project needs attention" button opens it. No agent calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import SidebarNav from "/src/components/SidebarNav";
import { updateSettings } from "/src/lib/settings";
import { attentionLabel } from "@milagre/shared/attention";
import { AttentionButton } from "/src/components/changes/ChangesChrome";
import "/src/styles.css";
window.milagre = {
  listRecentProjects: async () => [{ path: "/work/arketa", name: "arketa" }, { path: "/work/milagre-ade", name: "milagre-ade" }],
  readProject: async (path) => ({ path, name: path, state: { sessions: {}, worktrees: {}, messages: [] } }),
  listProjects: async () => [], listNamedLinks: async () => [], getProjectImage: async () => null,
};
updateSettings({ chatList: "grouped" });
function Fixture() {
  const [waiting, setWaiting] = useState(["/work/milagre-ade", "/work/shop"]);
  const items = [
    { key: "/work/milagre-ade#4", project: "milagre-ade", title: "Add attention indicators", asking: false },
    { key: "/work/shop#9", project: "shop", title: "Which checkout layout?", asking: true },
  ].filter(item => waiting.some(path => item.key.startsWith(path + "#")));
  return <div style={{ display: "flex", height: "100vh", padding: "60px 12px 12px" }}>
    <SidebarNav fill workspaceName="arketa" projectPath="/work/arketa" recents={[{ id: "1", label: "Fix the login flow" }]} activeId="1" attentionPaths={waiting} />
    {waiting.length > 0 && <AttentionButton label={attentionLabel(items.map(item => item.title))} items={items}
      offset={0} onOpen={key => { window.opened = key; setWaiting(waiting.filter(path => !key.startsWith(path + "#"))); }} />}
  </div>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 560, show: false, webPreferences: { backgroundThrottling: false } });
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
  const click = async (selector) => {
    const point = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await delay(200);
  };
  const dots = (scope) => evaluate(`document.querySelectorAll(${JSON.stringify(scope + ' [aria-label="Needs attention"]')}).length`);
  try {
    await window.loadURL(process.argv[2]);
    const group = '[data-sidebar-scope="/work/milagre-ade"]';
    await waitFor(`!!document.querySelector('${group}')`);
    assert.equal(await dots(group), 1, "The waiting project's group shows a dot");
    assert.equal(await dots('[data-sidebar-scope="/work/arketa"]'), 0, "The open project's group does not");
    assert.equal(await evaluate(`document.querySelector("[data-attention-button]")?.textContent`), "2 Chats need attention");
    await screenshot("button");

    // Two waiting: the button opens a menu to pick one.
    await click("[data-attention-button]");
    await waitFor(`!!document.querySelector("[data-attention-menu]")`);
    assert.equal(await evaluate(`document.querySelectorAll("[data-attention-chat]").length`), 2);
    await screenshot("attention-menu");
    await click('[data-attention-chat="/work/shop#9"]');
    assert.equal(await evaluate("window.opened"), "/work/shop#9", "Picking a row opens that chat");
    assert.equal(await evaluate(`!!document.querySelector("[data-attention-menu]")`), false, "Picking closes the menu");

    // One left: a click opens it directly.
    assert.equal(await evaluate(`document.querySelector("[data-attention-button]")?.textContent`), "Add attention indicators needs attention");
    await click("[data-attention-button]");
    await waitFor(`!document.querySelector("[data-attention-button]")`);
    assert.equal(await evaluate("window.opened"), "/work/milagre-ade#4", "The button opens the only waiting chat");
    assert.equal(await dots(group), 0, "The dot goes once nothing waits");
    assert.deepEqual(errors, []);
    console.log("PASS: other projects' waiting chats dot their sidebar group; the attention button opens one chat, or a menu to pick among several");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-project-attention"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "project-attention-fixture",
        resolveId(id) {
          if (id === "/__project-attention.tsx") return id;
        },
        load(id) {
          if (id === "/__project-attention.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__project-attention") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__project-attention.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__project-attention`], {
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
