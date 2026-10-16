// Browser check: a bot's thread and its profile. The sign-off card shows the gated command, when it expires and the
// three answers, and each answer reaches the runtime; an expired one says so with no buttons. A Chat the bot opened
// shows as a card whose Open Chat opens it. The composer says "Bot rules" and its mode can't be changed. The profile
// edits the brief and the memory, lists the bot's Chats, revokes a standing sign-off and deletes the bot after asking.
// Pausing reads Resume after, and a paused bot's composer says so and sends nothing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BotThread } from "/src/components/bots/BotThread";
import { BotProfilePanel } from "/src/components/bots/BotProfilePanel";
import { BotList } from "/src/components/bots/BotList";
import { MODEL_CATALOG } from "/src/model";
import { startRun } from "@milagre/shared/agent-runs";
import { AI_CONSENT_VERSION } from "@milagre/shared/ai-consent";
import "/src/styles.css";
// Allowing a sign-off lets the bot's turn go on, which needs AI sharing allowed on this device.
localStorage.setItem("milagre.ai-sharing-consent", AI_CONSENT_VERSION);
const HOME = "/d/bots/ops";
const CLAUDE = MODEL_CATALOG.find((model) => model.provider === "claude");
const PROJECT = "/work/milagre-ade";
const now = Date.now();
const gate = (requestId, title, command, expiresAt) => ({ kind: "merge", title, command, target: PROJECT, botId: "ops", botName: "Ops", expiresAt });
const ops = {
  id: "ops", name: "Ops", role: "Keeps main green and PRs moving", color: "#3b82f6", body: "circle", provider: "claude", model: CLAUDE.id,
  projects: [PROJECT], paused: false, homePath: HOME, homeWorktreeId: 1, threadSessionId: 1, createdAt: 1,
  preview: "Merge #474 needs your sign-off", lastAt: now, unread: false, pendingGates: 1,
};
const message = (id, role, body, context = null) => ({ id, session_id: 1, role, body, context });
const MESSAGES = [
  message(1, "assistant", "main went red at 07:12: terminal-perf.test.cjs timed out on shard 2. Third time this week on unrelated PRs, so it's flaky, not a real break. I opened a Chat to fix it."),
  message(2, "user", "Chat finished: Fix flaky terminal-perf test", { kind: "bot-chat-finished", chatKey: "/p#4", status: "done" }),
  message(3, "user", "Is it hiding a real timeout, or is it the shared runner?"),
  message(4, "assistant", "Shared runner. The test waits 2 s while four shards share one machine. The fix waits for the first frame instead, and CI passed twice on the branch."),
  message(5, "user", "Sign-off for Delete branch ops/old expired.", { kind: "bot-gate-expired", requestId: "r0", chatKey: "/p#4" }),
];
window.calls = [];
const record = (name) => async (...args) => { window.calls.push([name, ...args]); };
window.milagre = {
  listEditors: async () => [],
  readChatMessages: async () => ({ messages: MESSAGES, hasMore: false, total: MESSAGES.length }),
  answerBotGate: record("answerBotGate"),
  revokeBotGrant: record("revokeBotGrant"),
  removeBot: record("removeBot"),
  saveBotMemory: record("saveBotMemory"),
  readBotBrief: async () => ({ text: "Watch main, open PRs and CI on the-ptf/milagre. Fix flakes by opening a Milagre Chat." }),
  readBotMemory: async () => ({ text: "# Memory\\n\\n## Flaky tests\\n- terminal-perf on shard 2\\n", lines: 64, bytes: 900 }),
  updateBot: async (id, patch) => { window.calls.push(["updateBot", id, patch]); window.patchBot(patch); return { ...ops, ...patch }; },
};
const snapshot = (bot) => ({
  enabled: true,
  bots: [bot],
  gates: [{ requestId: "r0", botId: "ops", chatKey: "/p#4", status: "expired", createdAt: now - 7200000, meta: gate("r0", "Delete branch ops/old", "git push origin --delete ops/old", now - 3600000) }],
  grants: [{ id: "g1", botId: "ops", gate: "merge", target: PROJECT, createdAt: now, revokedAt: null }],
  chats: [
    { chatKey: "/p#4", botId: "ops", title: "Fix flaky terminal-perf test", projectPath: PROJECT, status: "done", createdAt: 2 },
    { chatKey: "/p#7", botId: "ops", title: "Bump expo-notifications patch", projectPath: PROJECT, status: "running", createdAt: 3 },
  ],
});
let runs = startRun({}, HOME + "#1", CLAUDE.id, "bot");
runs = { [HOME + "#1"]: { ...runs[HOME + "#1"], approvals: [{ requestId: "r1", kind: "command", tool: "Bash", title: "Merge PR #474", command: "gh pr merge 474 --squash", allowForChat: false,
  gate: gate("r1", "Merge PR #474 into main", "gh pr merge 474 --squash", now + 3600000) }] } };
window.sent = [];
const agents = {
  runs,
  send: async (request) => { window.sent.push(request); return { sessionId: 1 }; },
  interrupt: async () => {},
  respond: async () => {},
  answerQuestion: async () => {},
};
function Fixture() {
  const [bot, setBot] = useState(ops);
  const [mount, setMount] = useState(0);
  const [profile, setProfile] = useState(true);
  window.patchBot = (patch) => setBot((current) => ({ ...current, ...patch }));
  window.remount = () => setMount((value) => value + 1);
  const shown = snapshot(bot);
  return (
    <div style={{ display: "flex", height: "100vh", gap: 12, padding: "0 12px 12px", boxSizing: "border-box" }}>
      <div style={{ width: 252, paddingTop: 52 }} className="flex shrink-0 flex-col rounded-window bg-surface shadow-card">
        <BotList snapshot={{ ...shown, gates: [...shown.gates, { requestId: "r1", botId: "ops", chatKey: HOME + "#1", status: "pending", createdAt: now, meta: gate("r1", "", "", 0) }] }}
          selectedBotId="ops" onPickBot={() => {}} collapsed={false} />
      </div>
      <main data-chat-pane style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <BotThread key={mount} bot={bot} snapshot={shown} agents={agents} preferences={{ models: MODEL_CATALOG, cliStatus: null }}
          onOpenChat={(key) => { window.opened = key; }} profileOpen={profile} onToggleProfile={() => setProfile((open) => !open)} />
      </main>
      {profile && (
        <div style={{ width: 320, paddingTop: 52 }} className="flex min-h-0 shrink-0 rounded-window bg-surface shadow-card">
          <BotProfilePanel bot={bot} snapshot={shown} onOpenChat={(key) => { window.opened = key; }} />
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-bots-thread-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
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
    await delay(600);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const calls = (name) => evaluate(`window.calls.filter((call) => call[0] === ${JSON.stringify(name)}).map((call) => call.slice(1))`);
  const button = (scope, label) =>
    `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  const pending = '[data-gate-status="pending"]';
  const prompt = 'textarea[aria-label="Prompt"]';
  const type = async (text) => {
    await evaluate(`document.querySelector(${JSON.stringify(prompt)}).focus()`);
    window.webContents.insertText(text);
    await delay(100);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await delay(300);
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector(${JSON.stringify(pending)}) && !!document.querySelector('[data-bot-chat-card="/p#4"]')`);

    // The sign-off card.
    const card = await evaluate(`document.querySelector(${JSON.stringify(pending)}).textContent`);
    assert.match(card, /Needs your sign-off/);
    assert.match(card, /Merge PR #474 into main/);
    assert.match(card, /gh pr merge 474 --squash/);
    assert.match(card, /Expires \d\d:\d\d/);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll(${JSON.stringify(`${pending} button`)})].map((b) => b.textContent.trim())`), [
      "Allow once",
      "Always for Ops",
      "Deny",
    ]);
    // An expired one: no buttons.
    const expired = '[data-gate-status="expired"]';
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(expired)}).textContent`), /Expired/);
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(`${expired} button`)}).length`), 0, "An expired sign-off can't be answered");
    // A Chat the bot opened.
    const chatCard = '[data-bot-chat-card="/p#4"]';
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(chatCard)}).textContent`), /Fix flaky terminal-perf test[\s\S]*Open Chat/);
    // The composer: Bot rules, locked.
    const chip = 'button[aria-label="Agent permissions"]';
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(chip)}).textContent.trim()`), "Bot rules");
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(chip)}).disabled`), true, "The mode picker is disabled");
    // The profile.
    const profile = '[data-bot-profile="ops"]';
    await waitFor(`document.querySelector('${profile} textarea[aria-label="Brief"]')?.value.startsWith("Watch main")`);
    await waitFor(`document.querySelector("[data-memory-lines]")?.textContent.includes("64 of 200 lines")`);
    const profileText = await evaluate(`document.querySelector(${JSON.stringify(profile)}).textContent`);
    assert.match(profileText, /Brief/);
    assert.match(profileText, /Chats Ops opened[\s\S]*Fix flaky terminal-perf test[\s\S]*Done/);
    assert.match(profileText, /Bump expo-notifications patch[\s\S]*Running/);
    assert.match(profileText, /Memory[\s\S]*MEMORY\.md · 64 of 200 lines[\s\S]*Open/);
    await screenshot("bots-thread");

    // Sending goes to the thread, in Bot rules.
    await type("Is main green?");
    await waitFor("window.sent.length === 1");
    assert.deepEqual(
      await evaluate(
        `(({ projectPath, sessionId, worktreeId, body, permissionMode }) => ({ projectPath, sessionId, worktreeId, body, permissionMode }))(window.sent[0])`,
      ),
      {
        projectPath: "/d/bots/ops",
        sessionId: 1,
        worktreeId: 1,
        body: "Is main green?",
        permissionMode: "bot",
      },
    );

    // Answers.
    await evaluate(`${button(pending, "Always for Ops")}.click()`);
    await waitFor(`${button(pending, "Deny")}.disabled`);
    assert.deepEqual(await calls("answerBotGate"), [["r1", "always"]]);
    await evaluate("window.remount()");
    await waitFor(`!${button(pending, "Deny")}.disabled`);
    await evaluate(`${button(pending, "Deny")}.click()`);
    await waitFor(`window.calls.filter((call) => call[0] === "answerBotGate").length === 2`);
    assert.deepEqual((await calls("answerBotGate"))[1], ["r1", "deny"]);
    await evaluate(`${button(chatCard, "Open Chat")}.click()`);
    assert.equal(await evaluate("window.opened"), "/p#4");

    // Brief: Save shows once it changes.
    await evaluate(`(() => {
      const field = document.querySelector('${profile} textarea[aria-label="Brief"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, "Watch main only.");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor(`!!${button(profile, "Save")}`);
    await evaluate(`${button(profile, "Save")}.click()`);
    await waitFor(`window.calls.some((call) => call[0] === "updateBot")`);
    assert.deepEqual(await calls("updateBot"), [["ops", { brief: "Watch main only." }]]);
    // Memory opens in an editable sheet.
    await evaluate(`${button(profile, "Open")}.click()`);
    await waitFor(`document.querySelector("[data-memory-sheet]")?.open`);
    await evaluate(`(() => {
      const field = document.querySelector('[data-memory-sheet] textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, field.value + "- never merge on Fridays\\n");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await screenshot("bots-memory");
    await evaluate(`${button("[data-memory-sheet]", "Save")}.click()`);
    await waitFor(`!document.querySelector("[data-memory-sheet]")`);
    assert.deepEqual(await calls("saveBotMemory"), [["ops", "# Memory\n\n## Flaky tests\n- terminal-perf on shard 2\n- never merge on Fridays\n"]]);
    // Revoke a standing sign-off.
    assert.match(await evaluate(`document.querySelector('[data-grant="g1"]').textContent`), /Merge · milagre-ade/);
    await evaluate(`${button('[data-grant="g1"]', "Revoke")}.click()`);
    await waitFor(`window.calls.some((call) => call[0] === "revokeBotGrant")`);
    assert.deepEqual(await calls("revokeBotGrant"), [["g1"]]);
    // Delete, after asking.
    await evaluate(`${button(profile, "Delete bot")}.click()`);
    await waitFor(`!!document.querySelector("[data-delete-confirm]")`);
    assert.match(await evaluate(`document.querySelector("[data-delete-confirm]").textContent`), /Delete Ops\? Its Chats stay in Milagre as yours\./);
    assert.deepEqual(await calls("removeBot"), [], "Nothing is deleted before the answer");
    await evaluate(`${button("[data-delete-confirm]", "Delete")}.click()`);
    await waitFor(`window.calls.some((call) => call[0] === "removeBot")`);
    assert.deepEqual(await calls("removeBot"), [["ops"]]);

    // Pause: the button reads Resume and the composer sends nothing.
    await evaluate(`document.querySelector('[data-bot-thread] button[aria-label="Pause"]').click()`);
    await waitFor(`!!document.querySelector('[data-bot-thread] button[aria-label="Resume"]')`);
    assert.deepEqual((await calls("updateBot"))[1], ["ops", { paused: true }]);
    await waitFor(`document.querySelector("[data-bot-thread]").textContent.includes("Ops is paused.")`);
    await type("Still there?");
    assert.equal(await evaluate("window.sent.length"), 1, "A paused bot's composer sends nothing");
    await screenshot("bots-thread-paused");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: the sign-off card shows the command, its expiry and Allow once / Always for Ops / Deny, each answer reaches the runtime, an expired one has no buttons; a bot Chat's card opens it; the composer is locked to Bot rules and sends to the thread; the profile saves the brief and the memory, lists the bot's Chats, revokes a grant and deletes after asking; Pause turns to Resume and a paused bot sends nothing",
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
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-bots-thread"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "bots-thread-fixture",
        resolveId(id) {
          if (id === "/__bots-thread.tsx") return id;
        },
        load(id) {
          if (id === "/__bots-thread.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__bots-thread") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__bots-thread.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__bots-thread`], {
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
