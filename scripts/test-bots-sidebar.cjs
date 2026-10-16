// Browser check: with Bots on (Settings › Experimental), the sidebar gets a Projects | Bots switch. Bots lists each bot
// with its last line and a "Needs you" row counting its pending sign-offs; New bot opens the starter's setup card and
// creates the bot from it. Collapsed, the switch is two icon buttons. In Projects, a Chat a bot opened and still runs
// says "from <Bot name>"; one Victor took over doesn't. With Bots off there is no switch.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import SidebarNav from "/src/components/SidebarNav";
import { updateSettings } from "/src/lib/settings";
import { DESKTOP_CHAT_ROW_SHOW } from "@milagre/shared/chat-row";
import "/src/styles.css";
const PROJECT = "/work/arketa";
const MODEL = { id: "claude-opus-test", name: "Opus test", provider: "claude", description: "" };
window.MODEL = MODEL;
window.PROJECT = PROJECT;
const ops = {
  id: "ops", name: "Ops", role: "Keeps main green and PRs moving", color: "#3b82f6", body: "circle", provider: "claude", model: MODEL.id,
  projects: [PROJECT], paused: false, homePath: "/d/bots/ops", homeWorktreeId: 1, threadSessionId: 1, createdAt: 1,
};
const snapshot = (enabled) => ({
  enabled,
  bots: [{ ...ops, preview: "Merge #474 needs your sign-off", lastAt: Date.now() - 60000, unread: false, pendingGates: 1 }],
  gates: [{ requestId: "r1", botId: "ops", chatKey: PROJECT + "#4", status: "pending", createdAt: 1,
    meta: { kind: "merge", title: "Merge PR #474", command: "gh pr merge 474 --squash", target: PROJECT, botId: "ops", botName: "Ops", expiresAt: Date.now() + 3600000 } }],
  grants: [],
  chats: [
    { chatKey: PROJECT + "#4", botId: "ops", title: "Fix flaky terminal-perf test", projectPath: PROJECT, status: "running", createdAt: 1 },
    { chatKey: PROJECT + "#6", botId: "ops", title: "Bump expo-notifications", projectPath: PROJECT, status: "taken-over", createdAt: 2 },
  ],
});
let enabled = false;
const listeners = { changed: new Set(), enabled: new Set() };
window.setBots = (on) => {
  enabled = on;
  for (const listener of listeners.enabled) listener({ enabled: on });
  for (const listener of listeners.changed) listener(snapshot(on));
};
window.created = [];
window.picked = [];
window.milagre = {
  listRecentProjects: async () => [{ path: PROJECT, name: "arketa" }],
  listProjects: async () => [],
  listNamedLinks: async () => [],
  getProjectImage: async () => null,
  listEditors: async () => [],
  onProjectState: () => () => {},
  onLinkState: () => () => {},
  readBotsEnabled: async () => ({ enabled }),
  listBots: async () => snapshot(enabled),
  onBotsChanged: (callback) => (listeners.changed.add(callback), () => listeners.changed.delete(callback)),
  onBotsEnabledChanged: (callback) => (listeners.enabled.add(callback), () => listeners.enabled.delete(callback)),
  botTemplates: async () => [
    {
      id: "ops", name: "Ops", role: "Keeps main green and PRs moving", color: "#3b82f6", body: "circle",
      fields: [
        { id: "projects", label: "Projects to watch", kind: "projects", required: true, options: [{ value: PROJECT, label: "arketa" }] },
        { id: "ci", label: "Checks that count as CI", kind: "text", required: false },
        { id: "linearTeam", label: "Linear team", kind: "text", required: false },
      ],
    },
  ],
  createBot: async (input) => {
    window.created.push(input);
    return { ...ops, name: input.name };
  },
};
localStorage.removeItem("milagre.sidebarClosedScopes");
updateSettings({ legacySidebar: true, chatRowShow: DESKTOP_CHAT_ROW_SHOW });
const rows = [
  { id: "4", label: "Fix flaky terminal-perf test", mark: "running", details: { path: PROJECT, branch: "ops/flaky-shard-2" } },
  { id: "6", label: "Bump expo-notifications", details: { path: PROJECT, branch: "main" } },
  { id: "5", label: "My own chat", details: { path: PROJECT, branch: "main" } },
];
function Fixture() {
  const [mode, setMode] = useState("projects");
  const [bot, setBot] = useState(null);
  return (
    <div data-mode={mode} style={{ display: "flex", height: "100vh", padding: "60px 12px 12px" }}>
      <SidebarNav fill workspaceName="arketa" projectPath={PROJECT} recents={rows} activeId="5"
        sidebarMode={mode} onSidebarMode={setMode} selectedBotId={bot}
        onPickBot={(id) => { window.picked.push(id); setBot(id); }}
        models={[MODEL]} defaultModel={MODEL} />
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-bots-sidebar-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1100, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
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
    window.webContents.invalidate();
    await delay(300);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  const sheet = "document.querySelector('[data-new-bot-sheet]')";
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-chat-id="5"]')`);
    // Off: no switch.
    await delay(200);
    assert.equal(await evaluate(`!!document.querySelector("[data-sidebar-mode-switch]")`), false, "Bots off: no Projects | Bots switch");

    await evaluate(`window.setBots(true)`);
    await waitFor(`!!document.querySelector("[data-sidebar-mode-switch]")`);
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll("[data-sidebar-mode-switch] [data-sidebar-mode]")].map((button) => button.textContent.trim())`),
      ["Projects", "Bots"],
    );
    // Projects: the Chat Ops runs says so, the one Victor took over and his own don't.
    const mark = '[data-chat-id="4"] [data-bot-mark="ops"]';
    await waitFor(`!!document.querySelector(${JSON.stringify(mark)})`);
    assert.equal((await text(mark)).trim(), "from Ops");
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${mark} svg`)})?.getAttribute("width")`), "14", "Its mascot is 14 px");
    assert.equal(await evaluate(`!!document.querySelector('[data-chat-id="6"] [data-bot-mark]')`), false, "A taken-over Chat has no mark");
    assert.equal(await evaluate(`!!document.querySelector('[data-chat-id="5"] [data-bot-mark]')`), false);
    await screenshot("bots-sidebar-projects");

    // Bots: the list, and what waits on Victor.
    await evaluate(`document.querySelector('[data-sidebar-mode="bots"]').click()`);
    await waitFor(`!!document.querySelector('[data-bot-id="ops"]')`);
    assert.match(await text('[data-bot-id="ops"]'), /Ops[\s\S]*Merge #474 needs your sign-off/);
    assert.equal(await evaluate(`!!document.querySelector('[data-chat-id]')`), false, "No Chat rows in Bots");
    assert.match(await text("[data-needs-you]"), /^Needs you/);
    assert.equal((await text("[data-needs-you-count]")).trim(), "1");
    assert.equal(await evaluate(`document.querySelector('[data-sidebar-mode="bots"]').getAttribute("aria-pressed")`), "true");
    await evaluate(`document.querySelector("[data-needs-you]").click()`);
    await waitFor(`document.querySelector('[data-bot-id="ops"]').getAttribute("aria-current") === "page"`);
    assert.deepEqual(await evaluate("window.picked"), ["ops"], "Needs you opens the bot that asks");
    await screenshot("bots-sidebar");

    // New bot: the Ops setup card.
    await evaluate(`document.querySelector("[data-new-bot]").click()`);
    await waitFor(`${sheet}?.textContent.includes("Projects to watch")`);
    const sheetText = await evaluate(`${sheet}.textContent`);
    for (const label of ["New bot", "Name", "Projects to watch", "Checks that count as CI", "Linear team", "Model"])
      assert.ok(sheetText.includes(label), `The sheet asks for ${label}`);
    assert.equal(await evaluate(`${sheet}.querySelector("#new-bot-name").value`), "Ops", "Named after its template");
    assert.equal(await evaluate(`${sheet}.querySelector('button[type="submit"]').disabled`), true, "A Project to watch is required");
    await evaluate(`${sheet}.querySelector('input[type="checkbox"][value="/work/arketa"]').click()`);
    await waitFor(`!${sheet}.querySelector('button[type="submit"]').disabled`);
    await screenshot("bots-new-bot");
    await evaluate(`${sheet}.querySelector('button[type="submit"]').click()`);
    await waitFor(`window.created.length === 1 && !${sheet}`);
    assert.deepEqual(await evaluate("window.created[0]"), {
      templateId: "ops",
      name: "Ops",
      answers: { projects: ["/work/arketa"], ci: "", linearTeam: "" },
      provider: "claude",
      model: "claude-opus-test",
    });
    assert.deepEqual(await evaluate("window.picked"), ["ops", "ops"], "The new bot opens");

    // Collapsed: two icon buttons.
    await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`);
    await waitFor(`Math.round(document.querySelector("aside").getBoundingClientRect().width) === 44`);
    assert.deepEqual(
      await evaluate(
        `[...document.querySelectorAll("[data-sidebar-mode-switch] [data-sidebar-mode]")].map((button) => { const r = button.getBoundingClientRect(); return [button.getAttribute("aria-label"), Math.round(r.width), Math.round(r.height)]; })`,
      ),
      [
        ["Projects", 32, 32],
        ["Bots", 32, 32],
      ],
    );
    await screenshot("bots-sidebar-collapsed");
    await evaluate(`document.querySelector('[aria-label="Expand sidebar"]').click()`);
    await waitFor(`Math.round(document.querySelector("aside").getBoundingClientRect().width) > 44`);

    // Bots off again: no switch and Projects is back (App does the same with its sidebarMode).
    await evaluate(`window.setBots(false)`);
    await waitFor(`!document.querySelector("[data-sidebar-mode-switch]") && !!document.querySelector('[data-chat-id="5"]')`);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: Bots on shows a Projects | Bots switch (two icons collapsed) and Bots lists Ops with its last line under "Needs you" 1; New bot asks for the Ops setup and creates it; a running bot Chat says "from Ops" and a taken-over one doesn\'t; Bots off hides the switch',
    );
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
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-bots-sidebar"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "bots-sidebar-fixture",
        resolveId(id) {
          if (id === "/__bots-sidebar.tsx") return id;
        },
        load(id) {
          if (id === "/__bots-sidebar.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__bots-sidebar") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__bots-sidebar.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__bots-sidebar`], {
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
