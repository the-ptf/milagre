const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runTool } = require("../linked-tools.cjs");
const { createBotHome } = require("./home.cjs");
const { createBotStore } = require("./store.cjs");
const { createBots } = require("./index.cjs");

const NOW = 1_000_000;
const PROJECT = "/Code/milagre-ade";
const META = Object.freeze({
  kind: "merge",
  title: "Merge PR #474",
  command: "gh pr merge 474",
  target: PROJECT,
  botId: "ops",
  botName: "Ops",
  expiresAt: NOW + 3_600_000,
});

// The service on a real store and home, with a fake Milagre MCP host (it records the Worktrees and Chats it makes),
// fake agent sessions and fake Chats.
async function harness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-bots-chats-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = await createBotHome(path.join(dir, "bots"), "ops");
  const OPS = {
    id: "ops",
    name: "Ops",
    role: "Keeps main green and PRs moving",
    color: "#3b82f6",
    body: "circle",
    provider: "claude",
    model: "claude-sonnet",
    projects: [PROJECT],
    paused: false,
    homePath: home,
    homeWorktreeId: 1,
    threadSessionId: 1,
    createdAt: NOW,
  };
  const store = createBotStore(path.join(dir, "angelo.db"));
  store.setEnabled(true);
  store.insertBot(OPS);
  const host = {
    worktrees: [],
    chats: [],
    async createWorktree(args, operationId) {
      this.worktrees.push({ ...args, operationId });
      return { projectPath: args.projectPath, worktreeId: this.worktrees.length + 1 };
    },
    async createChat({ projectPath, worktreeId }, operationId) {
      this.chats.push({ projectPath, worktreeId, operationId });
      return { chatId: `${projectPath}#${this.chats.length + 3}` };
    },
  };
  const agents = {
    responses: [],
    hasSession: () => false,
    respondToPermission(...args) {
      this.responses.push(args);
      return true;
    },
  };
  const chats = {
    sent: [],
    async send(request) {
      this.sent.push(request);
      return { sessionId: request.sessionId };
    },
  };
  const titles = [];
  const closed = [];
  const bots = createBots({
    dataDir: dir,
    store,
    chats,
    agents,
    host,
    openHome: async () => ({ state: {} }),
    closeHome: async (projectPath) => closed.push(projectPath),
    chatDetails: async () => ({ lastReply: "Fixed the flaky terminal-perf test; PR #475 is open.", pullRequests: ["https://github.com/o/r/pull/475"] }),
    titleChat: async (chatKey, title) => titles.push([chatKey, title]),
    now: () => NOW,
    ...overrides,
  });
  t.after(() => bots.close());
  const open = (title = "Fix flaky terminal-perf test") => bots.chatOpen("ops", { project: PROJECT, title, prompt: "Fix it" });
  return { bots, store, host, agents, chats, titles, closed, open, OPS, THREAD: `${home}#1` };
}

test("chat_open only reaches the bot's projects", async (t) => {
  const { bots, host } = await harness(t);
  await assert.rejects(bots.chatOpen("ops", { project: "/elsewhere", title: "x", prompt: "y" }), /Ops may open Chats only in: milagre-ade\./);
  assert.deepEqual(host.worktrees, []);
});

test("chat_open makes a worktree and a Chat and starts it in Bot rules", async (t) => {
  const { bots, host, chats, store, titles, OPS, open } = await harness(t);
  const result = await open();
  assert.equal(result.chatKey, `${PROJECT}#4`);
  assert.equal(host.worktrees[0].baseBranch, "main");
  assert.equal(host.worktrees[0].projectPath, PROJECT);
  assert.match(host.worktrees[0].operationId, /^bot:ops:[0-9a-f-]{36}$/);
  assert.equal(host.chats[0].operationId, host.worktrees[0].operationId);
  assert.equal(chats.sent.at(-1).permissionMode, "bot");
  assert.equal(chats.sent.at(-1).model, OPS.model);
  assert.equal(chats.sent.at(-1).projectPath, PROJECT);
  assert.equal(chats.sent.at(-1).sessionId, 4);
  assert.equal(chats.sent.at(-1).context.kind, "bot-message");
  assert.equal(store.chat(result.chatKey).status, "running");
  assert.deepEqual(titles, [[result.chatKey, "Fix flaky terminal-perf test"]]);
  // A Project can be named, and the base chosen.
  await bots.chatOpen("ops", { project: "milagre-ade", title: "Second", prompt: "y", base: "release" });
  assert.equal(host.worktrees[1].baseBranch, "release");
});

test("a fourth running Chat is refused", async (t) => {
  const { open } = await harness(t);
  await open("one");
  await open("two");
  await open("three");
  await assert.rejects(open("four"), /Ops already has 3 Chats running\. Wait for one to finish or close one\./);
});

test("a paused bot opens no Chats", async (t) => {
  const { bots, host, open } = await harness(t);
  await bots.update("ops", { paused: true });
  await assert.rejects(open(), /Ops is paused\./);
  assert.deepEqual(host.worktrees, []);
});

test("when a Chat finishes, the bot thread gets a turn", async (t) => {
  const { bots, store, chats, OPS, open } = await harness(t);
  const { chatKey } = await open();
  await bots.observe(chatKey, { type: "turn-completed" });
  assert.equal(store.chat(chatKey).status, "done");
  assert.equal(chats.sent.at(-1).projectPath, OPS.homePath);
  assert.equal(chats.sent.at(-1).sessionId, OPS.threadSessionId);
  assert.equal(chats.sent.at(-1).permissionMode, "bot");
  assert.equal(chats.sent.at(-1).context.kind, "bot-chat-finished");
  assert.equal(chats.sent.at(-1).context.chatKey, chatKey);
  assert.match(chats.sent.at(-1).body, /Fix flaky terminal-perf test/);
  assert.match(chats.sent.at(-1).body, /PR #475 is open/);
  // A finished Chat no longer counts against the cap, and chat_send continues it.
  await bots.chatSend("ops", chatKey, "Rebase on main");
  assert.equal(store.chat(chatKey).status, "running");
  await bots.observe(chatKey, { type: "turn-failed" });
  assert.equal(store.chat(chatKey).status, "failed");
});

test("a quit leaves a bot Chat running, so it continues after the restart", async (t) => {
  const { bots, store, chats, open } = await harness(t);
  const { chatKey } = await open();
  const sent = chats.sent.length;
  await bots.observe(chatKey, { type: "turn-cancelled", quit: true });
  assert.equal(store.chat(chatKey).status, "running");
  assert.equal(chats.sent.length, sent);
  // Stop is not a quit: the Chat was stopped, and the bot hears it.
  await bots.observe(chatKey, { type: "turn-cancelled" });
  assert.equal(store.chat(chatKey).status, "failed");
  assert.match(chats.sent.at(-1).body, /^Chat was stopped:/);
});

test("nothing reaches a bot's thread while Milagre closes", async (t) => {
  let closing = false;
  const { bots, store, chats, open } = await harness(t, { closing: () => closing });
  const { chatKey } = await open();
  const sent = chats.sent.length;
  closing = true;
  await bots.observe(chatKey, { type: "turn-completed" });
  assert.equal(store.chat(chatKey).status, "done");
  assert.equal(chats.sent.length, sent);
});

test("chat_status reports the Chat and what it waits for", async (t) => {
  const { bots, open } = await harness(t);
  const { chatKey } = await open();
  await bots.observe(chatKey, { type: "permission-request", requestId: "r1", gate: META });
  const status = await bots.chatStatus("ops", chatKey);
  assert.equal(status.status, "running");
  assert.equal(status.project, "milagre-ade");
  assert.deepEqual(status.pullRequests, ["https://github.com/o/r/pull/475"]);
  assert.deepEqual(status.waitingForSignOff, ["Merge PR #474"]);
  await assert.rejects(bots.chatStatus("ops", "/Code/other#2"), /Ops didn't open that Chat\./);
});

test("Victor taking over a bot Chat ends the bot's hold on it", async (t) => {
  const { bots, store, chats, OPS, open } = await harness(t);
  const { chatKey } = await open();
  assert.ok(bots.policyFor(chatKey));
  await bots.takeOver(chatKey);
  assert.equal(store.chat(chatKey).status, "taken-over");
  await assert.rejects(bots.chatSend("ops", chatKey, "continue"), /Victor took over this Chat\./);
  assert.equal(bots.policyFor(chatKey), undefined);
  assert.equal(chats.sent.at(-1).projectPath, OPS.homePath);
  assert.equal(chats.sent.at(-1).context.kind, "bot-chat-taken-over");
  // Its turns end without telling the bot.
  const sent = chats.sent.length;
  await bots.observe(chatKey, { type: "turn-completed" });
  assert.equal(chats.sent.length, sent);
});

test("deleting a bot hands its running Chats to Victor and denies its sign-offs", async (t) => {
  const { bots, store, agents, closed, OPS, open } = await harness(t);
  const { chatKey } = await open();
  await bots.observe(chatKey, { type: "permission-request", requestId: "r1", gate: META });
  await bots.remove("ops");
  assert.equal(store.chat(chatKey).status, "taken-over");
  assert.deepEqual(agents.responses.at(-1), [chatKey, "r1", "deny"]);
  assert.deepEqual(closed, [OPS.homePath]);
  assert.equal(bots.policyFor(chatKey), undefined);
  assert.deepEqual(bots.snapshot().bots, []);
});

test("bot tools are only given to bot threads", async (t) => {
  const { bots, THREAD, open } = await harness(t);
  const { chatKey } = await open();
  assert.deepEqual(
    bots
      .toolsFor(THREAD)
      .map((tool) => tool.name)
      .toSorted(),
    ["chat_list_mine", "chat_open", "chat_send", "chat_status", "memory_read", "memory_write"],
  );
  assert.deepEqual(bots.toolsFor(chatKey), []);
  assert.deepEqual(bots.toolsFor("/Code/other#1"), []);
});

test("the Chat tools answer the bot in words", async (t) => {
  const { bots, THREAD } = await harness(t);
  const call = (name, args) =>
    runTool(
      bots.toolsFor(THREAD).find((tool) => tool.name === name),
      args,
    );
  assert.equal((await call("chat_list_mine", {})).text, "You haven't opened any Chats.");
  const opened = await call("chat_open", { project: "milagre-ade", title: "Fix it", prompt: "Fix the flaky test" });
  assert.equal(opened.text, `Opened ${PROJECT}#4: Fix it, in milagre-ade from main. You'll hear here when its turn ends.`);
  assert.equal((await call("chat_list_mine", {})).text, `- ${PROJECT}#4: Fix it (running)`);
  const refused = await call("chat_open", { project: "/elsewhere", title: "x", prompt: "y" });
  assert.equal(refused.isError, true);
  assert.equal(refused.text, "Ops may open Chats only in: milagre-ade.");
  assert.equal((await call("chat_send", { chat: `${PROJECT}#4`, text: "Also run the linter" })).text, "Sent.");
  assert.equal(JSON.parse((await call("chat_status", { chat: `${PROJECT}#4` })).text).title, "Fix it");
});
