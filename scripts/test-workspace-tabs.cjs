const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceTabStrip } from "/src/components/agents/WorkspaceTabStrip";
import { openBrowserTab } from "/src/lib/browser-panel";
import { useStage } from "/src/lib/workspace-stage";
import "/src/styles.css";
window.milagre = {};
const session = (id, worktree_id, extra = {}) => ({ id, worktree_id, title: "Chat " + id, provider: "claude", ...extra });
window.opened = [];
window.openPage = (chatId, url, agent) => openBrowserTab("/p#" + chatId, url, { agent });
function StageProbe() {
  const stage = useStage();
  return <output data-stage={stage ? stage.tab.kind + ":" + stage.chatKey : ""} />;
}
window.newChats = 0;
function Harness() {
  const [active, setActive] = useState(3);
  const [sessions, setSessions] = useState({ 1: session(1, 1), 2: session(2, 1, { parent: 1 }), 3: session(3, 1), 4: session(4, 2) });
  window.show = setActive;
  window.archive = (id) => setSessions((current) => ({ ...current, [id]: { ...current[id], archived: true } }));
  const rows = Object.values(sessions).map((chat) => ({ id: String(chat.id), label: chat.title, ...(chat.parent ? { parent: String(chat.parent) } : {}) }));
  return (
    <main style={{ position: "relative", height: 300 }}>
      <WorkspaceTabStrip
        workspace="/p#wt:1"
        projectPath="/p"
        panels={{}}
        sessions={sessions}
        belongs={(chat) => chat.worktree_id === 1}
        rows={rows}
        activeChatId={active}
        corner={0}
        menu={[]}
        onOpenChat={(id) => { window.opened.push(id); setActive(id); }}
        onNewChat={() => { window.newChats += 1; setActive(null); }}
      />
      <StageProbe />
    </main>
  );
}
createRoot(document.getElementById("root")).render(<Harness />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-workspace-tabs-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 400, show: false, webPreferences: { backgroundThrottling: false } });
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
  const tabs = () =>
    evaluate(`[...document.querySelectorAll("[data-workspace-tab]")].map((tab) => tab.dataset.workspaceTab + (tab.dataset.active ? "*" : ""))`);
  const expectTabs = async (expected, message) => {
    await waitFor(
      `JSON.stringify([...document.querySelectorAll("[data-workspace-tab]")].map((tab) => tab.dataset.workspaceTab + (tab.dataset.active ? "*" : ""))) === ${JSON.stringify(JSON.stringify(expected))}`,
    ).catch(() => {});
    assert.deepEqual(await tabs(), expected, message);
  };
  const pointer = (selector, type, x, button = 0) =>
    evaluate(`(() => {
      const target = ${selector === "window" ? "window" : `document.querySelector(${JSON.stringify(selector)})`};
      const rect = target === window ? { left: 0, top: 0, width: 0, height: 0 } : target.getBoundingClientRect();
      target.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, button: ${button}, clientX: ${x ?? "rect.left + rect.width / 2"}, clientY: rect.top + rect.height / 2 }));
    })()`);
  const press = (key) =>
    evaluate(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, ${process.platform === "darwin" ? "metaKey" : "ctrlKey"}: true, bubbles: true }))`,
    );
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`document.querySelector("[data-workspace-tabs]")`);
    await expectTabs(["chat:3*"], "the open Chat gets a tab");
    assert.deepEqual(
      await evaluate(
        `[...document.querySelectorAll("[data-workspace-tabs] button")].filter((button) => !button.closest(".no-drag")).map((button) => button.getAttribute("aria-label"))`,
      ),
      [],
      "every strip button sits in a no-drag area, so a mouse press reaches it instead of dragging the window",
    );
    await evaluate(`window.show(1)`);
    await expectTabs(["chat:3", "chat:1*"], "opening another Chat of the Worktree adds its tab at the end");
    await evaluate(`window.show(2)`);
    await expectTabs(["chat:3", "chat:1", "chat:2*"], "a Subchat opens after its parent");
    await evaluate(`window.show(4)`);
    await expectTabs(["chat:3", "chat:1", "chat:2*"], "a Chat of another Worktree adds nothing to this set");
    await evaluate(`window.show(2)`);
    await pointer('[data-workspace-tab="chat:3"]', "pointerdown");
    await pointer("window", "pointerup", 0);
    await expectTabs(["chat:3*", "chat:1", "chat:2"], "a click brings a tab forward");
    assert.equal(await evaluate(`window.opened.at(-1)`), 3);
    await press("9");
    await expectTabs(["chat:3", "chat:1", "chat:2*"], "the last digit picks the last tab");
    await press("2");
    await expectTabs(["chat:3", "chat:1*", "chat:2"], "a digit picks its tab");

    const left = await evaluate(`document.querySelector('[data-workspace-tab="chat:3"]').getBoundingClientRect().left`);
    const right = await evaluate(`document.querySelector('[data-workspace-tab="chat:2"]').getBoundingClientRect().right`);
    await pointer('[data-workspace-tab="chat:3"]', "pointerdown", left + 8);
    await pointer("window", "pointermove", left + 30);
    await pointer("window", "pointermove", right + 20);
    await pointer("window", "pointerup", right + 20);
    await expectTabs(["chat:1", "chat:2", "chat:3*"], "a dragged tab drops where it is let go");
    await evaluate(`window.show(1)`);

    await pointer('[data-workspace-tab="chat:2"]', "pointerdown", undefined, 1);
    await expectTabs(["chat:1*", "chat:3"], "a middle click closes a tab and leaves the open one in front");

    await evaluate(
      `document.querySelector('[data-workspace-tab="chat:1"] button[aria-label^="Close"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }))`,
    );
    await waitFor(`document.querySelector("[data-main-chat-close]")`);
    assert.match(await evaluate(`document.querySelector("[data-main-chat-close]").textContent`), /Close the main Chat\?/);
    await screenshot("main-chat-close");
    await evaluate(`[...document.querySelectorAll("[data-main-chat-close] button")].find((button) => button.textContent === "Cancel").click()`);
    await waitFor(`!document.querySelector("[data-main-chat-close]")`);
    await expectTabs(["chat:1*", "chat:3"], "Cancel keeps the main Chat's tab");
    await evaluate(
      `document.querySelector('[data-workspace-tab="chat:1"] button[aria-label^="Close"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }))`,
    );
    await waitFor(`document.querySelector("[data-main-chat-close]")`);
    await evaluate(`[...document.querySelectorAll("[data-main-chat-close] button")].find((button) => button.textContent === "Close tab").click()`);
    await expectTabs(["chat:3*"], "closing the tab in front brings its neighbour forward");
    assert.equal(await evaluate(`window.opened.at(-1)`), 3);

    await evaluate(`window.openPage(3, "https://example.com/agent", true)`);
    await waitFor(`[...document.querySelectorAll("[data-workspace-tab]")].some((tab) => tab.dataset.workspaceTab.startsWith("browser:3:"))`);
    const agentTab = await evaluate(`document.querySelector('[data-workspace-tab^="browser:3:"]').dataset.workspaceTab`);
    assert.equal(
      await evaluate(`!!document.querySelector('[data-workspace-tab="${agentTab}"] [aria-label="Unread"]')`),
      true,
      "a page the agent opens lands unread",
    );
    assert.equal(await evaluate(`document.querySelector("[data-stage]").dataset.stage`), "", "the Chat stays in front");
    await pointer(`[data-workspace-tab="${agentTab}"]`, "pointerdown");
    await pointer("window", "pointerup", 0);
    await waitFor(`document.querySelector("[data-stage]").dataset.stage === "browser:/p#3"`);
    await evaluate(`window.openPage(3, "https://example.com/mine", false)`);
    await waitFor(`document.querySelectorAll('[data-workspace-tab^="browser:3:"]').length === 2`);
    assert.match((await tabs()).find((tab) => tab.endsWith("*")) ?? "", /^browser:3:/, "a page the user opens comes forward");
    await evaluate(
      `document.querySelector('[data-workspace-tab="${agentTab}"] button[aria-label^="Close"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }))`,
    );
    await waitFor(`!document.querySelector('[data-workspace-tab="${agentTab}"]')`);
    await screenshot("page-tabs");
    await evaluate(`window.archive(3)`);
    await expectTabs([], "an archived Chat's tab closes, with its pages");
    await evaluate(`window.show(null)`);
    await expectTabs(["draft*"], "drafting a new Chat shows a New Chat tab");
    await screenshot("draft");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Chat and Subchat tabs open, switch by click and digit, reorder by drag, close by middle click, ask before the main Chat, drop archived Chats and show a New Chat draft, keep every button clear of the window drag area; Browser pages become tabs, unread when the agent opened them, and stage the page in front",
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
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-workspace-tabs"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "workspace-tabs-fixture",
        resolveId(id) {
          if (id === "/__workspace-tabs.tsx") return id;
        },
        load(id) {
          if (id === "/__workspace-tabs.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__workspace-tabs") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__workspace-tabs.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__workspace-tabs`], {
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
