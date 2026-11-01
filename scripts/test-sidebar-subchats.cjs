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
import "/src/styles.css";
window.milagre = {
 listRecentProjects: async () => [{ path: "/p", name: "P" }], listProjects: async () => [],
 listNamedLinks: async () => [], getProjectImage: async () => null, listEditors: async () => [],
 onProjectState: () => () => {}, onLinkState: () => () => {},
};
const recents = [
 { id: "2", label: "Child", parent: "1" },
 { id: "3", label: "Other" },
 { id: "1", label: "Parent" },
 { id: "4", label: "Pinned", pinned: true, pinOrder: 1 },
 { id: "5", label: "Done", doneAt: 1 },
];
window.setMode = (chatList) => updateSettings({ chatList });
window.setMode("list");
createRoot(document.getElementById("root")).render(
 <SidebarNav fill workspaceName="P" projectPath="/p" recents={recents} activeId="1"
   onJumpChatsChange={(ids) => { window.jumpIds = ids; }} />
);
`;
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
  const hints = async () => {
    // The hints follow the platform's shortcut modifier: ⌘ on a Mac, Ctrl on the Linux and Windows runners.
    const held = process.platform === "darwin" ? `{ key: "Meta", metaKey: true }` : `{ key: "Control", ctrlKey: true }`;
    await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", ${held}))`);
    await waitFor(`document.querySelector('[data-chat-id="1"] [data-shortcut-hint]')`);
    return evaluate(`[...document.querySelectorAll('[data-chat-id]')].flatMap(row => {
      const hint = row.querySelector('[data-shortcut-hint]');
      return hint ? [[row.dataset.chatId, Number(hint.getAttribute('aria-label').match(/[1-9]$/)[0])]] : [];
    }).sort((a,b) => a[1]-b[1]).map(([id]) => id)`);
  };
  const check = async (expected) => {
    assert.deepEqual(await hints(), expected, "hints follow the visible mode's order");
    assert.deepEqual(await evaluate(`window.jumpIds`), expected, "App keyboard targets match every displayed hint");
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`document.querySelector('[data-chat-id="1"]')`);
    // A family starts folded: its parent alone.
    await check(["4", "1", "3"]);
    for (const mode of ["grouped", "list"]) {
      await evaluate(`window.setMode(${JSON.stringify(mode)})`);
      await delay(150);
      await check(["4", "1", "3"]);
      assert.equal(await evaluate(`document.querySelector('[data-subchat-badge]').textContent.trim()`), "1", `${mode} folds from the icon's count`);
      await evaluate(`document.querySelector('[data-subchat-badge]').click()`);
      await delay(150);
      await check(["4", "1", "2", "3"]);
      await evaluate(`document.querySelector('button[aria-label="Hide 1 subchat of Parent"]').click()`);
      await delay(150);
      await check(["4", "1", "3"]);
      await evaluate(`document.querySelector('button[aria-label="Collapse sidebar"]').click()`);
      await delay(150);
      await check(["4", "2", "3", "1"]);
      await evaluate(`document.querySelector('button[aria-label="Expand sidebar"]').click()`);
      await delay(150);
      await check(["4", "1", "3"]);
    }
    assert.deepEqual(errors, []);
    console.log("PASS: grouped, One list and rail hints match keyboard targets with nested (folded at first), pinned and Done Chats");
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
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-sidebar-subchats"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "sidebar-subchats-fixture",
        resolveId(id) {
          if (id === "/__sidebar-subchats.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar-subchats.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__sidebar-subchats") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__sidebar-subchats.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar-subchats`], {
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
