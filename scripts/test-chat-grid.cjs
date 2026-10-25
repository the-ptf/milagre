// Run with node scripts/test-chat-grid.cjs. Renders the Chat grid with a focused Chat, one running, one waiting on an
// approval and one unread, then checks the layout and what a click on a tile does.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatGrid } from "/src/components/ChatGrid";
import { useScopeStates } from "/src/lib/sidebar-scopes";
import { ScopeContext } from "/src/lib/computer-bridge";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const unsubscribe = () => () => {};
// The sidebar's first read of another Project answers a little later, as the main process does.
const beta = { worktrees: {}, sessions: { 7: { id: 7, title: "Unread in beta", unread: true } }, messages: [] };
window.milagre = Object.freeze({
  listEditors: async () => [],
  on: unsubscribe,
  onAgentEvent: unsubscribe,
  onComputerEvent: unsubscribe,
  readProject: (path) => new Promise((resolve) => setTimeout(() => resolve({ path, name: "beta", state: beta }), 100)),
});
// The sidebar reads "/beta"; the grid reads nothing itself and must still hear that read.
function ScopeProbe() {
  useScopeStates(true, ["/beta"]);
  const { states } = useScopeStates(true, []);
  window.gridScopes = Object.keys(states);
  return null;
}
const noop = () => {};
const message = (id, session_id, role, body) => ({ id, session_id, role, body, context: null });
const titles = { 1: "Focused chat", 2: "Refactor the sidebar", 3: "Ship the release notes", 4: "Fix flaky test" };
const state = {
  worktrees: { 1: { id: 1, name: "main", path: "/fixture" } },
  sessions: Object.fromEntries(Object.entries(titles).map(([id, title]) => [id, { id: Number(id), title, worktree_id: 1, unread: id === "4" }])),
  messages: [1, 2, 3, 4].flatMap((id) => [
    message(id * 10 + 1, id, "user", "Please look at " + titles[id].toLowerCase() + "."),
    message(id * 10 + 2, id, "assistant", "Done with the first pass on " + titles[id].toLowerCase() + ". The change touches two files."),
  ]),
};
// A local tile's image, while the window's open Project is another Computer's.
state.messages.find((item) => item.id === 41).images = [{ id: "shot", name: "shot.png", path: "/fixture/shot.png" }];
const run = (extra) => ({ text: "Reading the files…", model: "x", steps: [], approvals: [], questions: [], answered: {}, startedAt: Date.now(), ...extra });
const runs = {
  "/fixture#2": run(),
  "/fixture#3": run({ approvals: [{ requestId: "r1", toolName: "Bash", input: {} }] }),
};
const model = MODEL_CATALOG[0];
const focusedChat = (
  <ChatComposer messages={state.messages.filter((item) => item.session_id === 1)}
    imageDraft={{ images: [], files: [], removeFile: noop, attachFiles: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
    projectPath="/fixture" draft="" onDraftChange={noop} onSend={noop} isSending={false} sendBlocked={false}
    models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
    capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
    fastMode={false} onFastModeChange={noop} permissionMode="auto" onPermissionModeChange={noop}
    onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
    isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
);
window.focusedTo = null;
window.dismissed = null;
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(
  <div style={{ height: "100vh", padding: 12 }}>
    <ScopeProbe />
    <ScopeContext.Provider value="mac-b|/remote">
    <ChatGrid keys={["/fixture#1", "/fixture#2", "/fixture#3", "/fixture#4"]} focused="/fixture#1"
      states={{ "/fixture": state }} runs={runs} delegated={new Set()} models={MODEL_CATALOG}
      onFocus={(key) => (window.focusedTo = key)} onDismiss={(key) => (window.dismissed = key)}>{focusedChat}</ChatGrid>
    </ScopeContext.Provider>
  </div>,
);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-chat-grid-")));
  await app.whenReady();
  // Inside CI's 1600x1200 virtual display (.github/workflows/ci.yml), which clamps any larger window.
  const window = new BrowserWindow({
    width: 1500,
    height: 1000,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(400);
    const image = await window.webContents.capturePage();
    require("node:fs").writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name), image.toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('document.querySelectorAll("[data-chat-tile]").length === 4');
    await waitFor('window.gridScopes?.includes("/beta")');
    assert.equal(
      await evaluate(`document.querySelector('[data-chat-tile="/fixture#4"] img')?.getAttribute("src")`),
      "milagre-media://file/?path=%2Ffixture%2Fshot.png",
      "A tile's images load from its own Computer, not the open Project's",
    );
    await screenshot("chat-grid.png");

    const tiles = await evaluate(`[...document.querySelectorAll("[data-chat-tile]")].map((tile) => {
      const rect = tile.getBoundingClientRect();
      return { key: tile.dataset.chatTile, top: Math.round(rect.top), left: Math.round(rect.left), width: rect.width, height: rect.height,
        prompt: !!tile.querySelector("[data-promptbar]"), text: tile.textContent };
    })`);
    assert.deepEqual(
      tiles.map((tile) => tile.key),
      ["/fixture#1", "/fixture#2", "/fixture#3", "/fixture#4"],
      "Tiles keep the order they are given",
    );
    assert.ok(
      tiles.every((tile) => tile.width >= 440 && tile.height >= 320),
      `Every tile is at least 440x320: ${JSON.stringify(tiles.map(({ width, height }) => [width, height]))}`,
    );
    assert.equal(new Set(tiles.map((tile) => tile.left)).size, 3, "Three 440px tiles fit across a 1500px window, the fourth wraps");
    assert.deepEqual(
      tiles.map((tile) => tile.prompt),
      [true, false, false, false],
      "Only the focused tile has a composer",
    );
    assert.ok(tiles[1].text.includes("Reading the files"), "A running tile streams its turn");
    assert.ok(tiles[2].text.includes("Needs you") && !tiles[1].text.includes("Needs you"), "Only the tile waiting on an approval says Needs you");
    assert.equal(await evaluate(`document.querySelectorAll("[data-tile-dismiss]").length`), 1, "Only the unread tile offers Mark read");

    await evaluate(`document.querySelector('[data-chat-tile="/fixture#4"] [data-tile-dismiss]').click()`);
    assert.equal(await evaluate("window.dismissed"), "/fixture#4", "Mark read dismisses the unread tile");
    assert.equal(await evaluate("window.focusedTo"), null, "Mark read does not focus the tile");
    await evaluate(`document.querySelector('[data-chat-tile="/fixture#2"]').click()`);
    assert.equal(await evaluate("window.focusedTo"), "/fixture#2", "Clicking a tile focuses its Chat");
    await evaluate(`window.focusedTo = null; document.querySelector('[data-chat-tile="/fixture#1"]').click()`);
    assert.equal(await evaluate("window.focusedTo"), null, "Clicking the focused tile changes nothing");

    window.setContentSize(1000, 900);
    await waitFor(
      `(() => { const tops = [...document.querySelectorAll("[data-chat-tile]")].map((tile) => Math.round(tile.getBoundingClientRect().top)); return new Set(tops).size === 2; })()`,
    );
    assert.ok(
      await evaluate(`(() => { const grid = document.querySelector("[data-chat-grid]"); return grid.scrollHeight <= grid.clientHeight + 1; })()`),
      "Two rows of 320px fit a 900px window without scrolling",
    );
    window.setContentSize(1000, 600);
    await waitFor(`(() => { const grid = document.querySelector("[data-chat-grid]"); return grid.scrollHeight > grid.clientHeight; })()`);
    await screenshot("chat-grid-narrow.png");

    console.log("PASS: tiles keep their order, fill the width at 440px or more, and scroll once rows would drop under 320px");
    console.log("PASS: the grid hears the sidebar's first read of another Project, so its unread Chats get tiles");
    console.log("PASS: only the focused tile has a composer; a waiting tile says Needs you; Mark read and clicking a tile call back");
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
        name: "chat-grid-fixture",
        resolveId(id) {
          if (id === "/__chat_grid_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__chat_grid_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__chat_grid__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__chat_grid_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__chat_grid__`], { env, stdio: "inherit" });
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
