const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");
const { runTool } = require("./linked-tools.cjs");

// A Project with one commit, and fake agents that record each turn they are asked to start.
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-bots-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-qb", "main", project]);
  execFileSync("git", [
    "-C",
    project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-qm",
    "Initial",
  ]);
  const dataDir = path.join(dir, "data");
  const events = [];
  const turns = [];
  const sessions = [];
  const runtimes = [];
  const make = () => {
    const runtime = createRuntime({
      dataDir,
      cwd: project,
      worktreeRoot: path.join(dir, "worktrees"),
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: async () => ({ command: "fixture" }),
      emit: (channel, payload) => events.push({ channel, payload }),
      createSession(provider, options) {
        const session = {
          provider,
          options,
          turnActive: false,
          closed: false,
          permissions: { mode: "ask" },
          startTurn: async (request) => {
            turns.push({ ...request, cwd: options.cwd });
            session.permissions.mode = request.permissionMode;
            options.emit({ type: "turn-started", turnId: "t" });
            options.emit({ type: "text-delta", messageId: `m${turns.length}`, text: "On it." });
            options.emit({ type: "turn-completed" });
            return { turnId: "t" };
          },
          answers: [],
          respondToPermission: (requestId, decision) => {
            session.answers.push([requestId, decision]);
            return true;
          },
          interrupt: async () => {},
          close: async () => {
            session.closed = true;
          },
        };
        sessions.push(session);
        return session;
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const runtime = make();
  await runtime.openProject(project);
  const input = { templateId: "ops", name: "Ops", answers: { projects: [project], ci: "CI / test" }, provider: "claude", model: "claude-sonnet" };
  return { dir, dataDir, project, events, turns, sessions, make, runtime, input };
}

async function withOps(t) {
  const f = await fixture(t);
  await f.runtime.invoke("bots:enabled:save", [true]);
  const bot = await f.runtime.invoke("bots:create", [f.input]);
  return { ...f, bot };
}

const turnIn = (turns, cwd) => turns.findLast((turn) => turn.cwd === cwd);

// Waits for an async check, e.g. a command's answer, to come true.
async function eventually(check, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("bots are off until turned on", async (t) => {
  const { runtime, events, input } = await fixture(t);
  assert.deepEqual(await runtime.invoke("bots:enabled:read"), { enabled: false });
  await assert.rejects(runtime.invoke("bots:create", [input]), /Bots are off\. Turn them on in Settings › Experimental\./);
  assert.deepEqual(await runtime.invoke("bots:enabled:save", [true]), { enabled: true });
  assert.deepEqual(events.find((event) => event.channel === "bots:enabled-changed").payload, { enabled: true });
  await assert.rejects(runtime.invoke("bots:enabled:save", ["yes"]), /boolean/);
});

test("creating Ops makes a hidden home with a thread", async (t) => {
  const { runtime, dataDir, events, input } = await fixture(t);
  await runtime.invoke("bots:enabled:save", [true]);
  const bot = await runtime.invoke("bots:create", [input]);
  assert.equal(bot.homePath, path.join(await fs.realpath(dataDir), "bots", "ops"));
  assert.equal(bot.role, "Keeps main green and PRs moving");
  assert.ok(bot.threadSessionId > 0);
  assert.ok(bot.homeWorktreeId > 0);
  assert.match(await fs.readFile(path.join(bot.homePath, "BRIEF.md"), "utf8"), /Keep the main branch/);
  const listed = await runtime.invoke("bots:list");
  assert.deepEqual(
    listed.bots.map((item) => item.id),
    ["ops"],
  );
  assert.equal(listed.enabled, true);
  assert.equal(events.findLast((event) => event.channel === "bots:changed").payload.bots[0].id, "ops");
  assert.equal(
    runtime.snapshot().projects.some((item) => item.path === bot.homePath),
    false,
  );
  assert.equal(
    (await runtime.invoke("project:registry")).some((item) => item.path === bot.homePath),
    false,
  );
  assert.equal(
    (await runtime.invoke("project:recent")).some((item) => item.path === bot.homePath),
    false,
  );
});

test("a second bot with the same name is refused", async (t) => {
  const { runtime, input } = await withOps(t);
  await assert.rejects(runtime.invoke("bots:create", [input]), /A bot named Ops already exists\./);
  await assert.rejects(runtime.invoke("bots:create", [{ ...input, name: " ops " }]), /A bot named ops already exists\./);
});

test("a bot only watches Projects open in Milagre", async (t) => {
  const { runtime, input } = await fixture(t);
  await runtime.invoke("bots:enabled:save", [true]);
  await assert.rejects(runtime.invoke("bots:create", [{ ...input, answers: { projects: ["/elsewhere"] } }]), /Open each Project in Milagre/);
  await assert.rejects(runtime.invoke("bots:create", [{ ...input, answers: {} }]), /Choose at least one Project/);
});

test("sending to a bot runs in Bot rules with fresh instructions", async (t) => {
  const { runtime, bot, turns } = await withOps(t);
  await runtime.invoke("bots:send", ["ops", "Is main green?"]);
  await waitUntil(() => turnIn(turns, bot.homePath));
  const turn = turnIn(turns, bot.homePath);
  assert.equal(turn.permissionMode, "bot");
  assert.equal(turn.model, "claude-sonnet");
  const instructions = await fs.readFile(path.join(bot.homePath, "AGENTS.md"), "utf8");
  assert.match(instructions, /You are Ops/);
  assert.match(instructions, /CI \/ test/);
  assert.equal(await fs.readFile(path.join(bot.homePath, "CLAUDE.md"), "utf8"), instructions);
  await waitUntil(() => runtime.snapshot().runs.runs[`${bot.homePath}#${bot.threadSessionId}`] === undefined);
  const summary = (await runtime.invoke("bots:list")).bots[0];
  assert.equal(summary.preview, "On it.");
  assert.equal(typeof summary.lastAt, "number");
});

test("a bot's thread stays out of the inbox", async (t) => {
  const { runtime, bot, turns } = await withOps(t);
  await runtime.invoke("bots:send", ["ops", "Is main green?"]);
  await waitUntil(() => turnIn(turns, bot.homePath));
  await waitUntil(() => runtime.snapshot().runs.runs[`${bot.homePath}#${bot.threadSessionId}`] === undefined);
  const inbox = await runtime.invoke("chat:inbox");
  assert.equal(
    inbox.agents.some((item) => item.projectPath === bot.homePath),
    false,
  );
});

test("chat:send into a bot thread is forced to Bot rules", async (t) => {
  const { runtime, bot, turns } = await withOps(t);
  await runtime.invoke("chat:send", [
    {
      projectPath: bot.homePath,
      sessionId: bot.threadSessionId,
      worktreeId: bot.homeWorktreeId,
      body: "hi",
      provider: "claude",
      model: "m",
      permissionMode: "full",
    },
  ]);
  await waitUntil(() => turnIn(turns, bot.homePath));
  assert.equal(turnIn(turns, bot.homePath).permissionMode, "bot");
  await assert.rejects(
    runtime.invoke("chat:send", [
      { projectPath: bot.homePath, sessionId: null, worktreeId: bot.homeWorktreeId, body: "a second thread", provider: "claude", model: "m" },
    ]),
    /Ops has one thread\./,
  );
});

test("a bot's thread session asks for sign-offs through the bots policy", async (t) => {
  const { runtime, bot, sessions } = await withOps(t);
  await runtime.invoke("bots:send", ["ops", "Merge 1 when green"]);
  await waitUntil(() => sessions.some((item) => item.options.cwd === bot.homePath));
  const session = sessions.find((item) => item.options.cwd === bot.homePath);
  assert.equal(session.options.permissionPolicy({ tool: "Bash", command: "ls" }), "allow");
  const { gate } = session.options.permissionPolicy({ tool: "Bash", command: "gh pr merge 1" });
  assert.equal(gate.title, "Merge PR #1");
  session.options.emit({ type: "permission-request", requestId: "r1", kind: "command", tool: "Bash", command: "gh pr merge 1", title: "x", gate });
  const gates = await eventually(async () => {
    const listed = (await runtime.invoke("bots:list")).gates;
    return listed.length ? listed : null;
  });
  assert.equal(gates[0].requestId, "r1");
  assert.equal((await runtime.invoke("bots:answer-gate", ["r1", "once"])).status, "allowed");
  assert.deepEqual(session.answers, [["r1", "allow"]]);
  // Projects' own Chats get no policy.
  assert.equal(
    sessions.filter((item) => item.options.cwd !== bot.homePath).every((item) => item.options.permissionPolicy === undefined),
    true,
  );
});

test("Victor sending in a bot Chat takes it over", async (t) => {
  const { runtime, bot, project, sessions, turns, dir } = await withOps(t);
  await runtime.invoke("bots:send", ["ops", "Fix the flaky test"]);
  await waitUntil(() => sessions.some((item) => item.options.cwd === bot.homePath));
  const thread = sessions.find((item) => item.options.cwd === bot.homePath);
  const tool = (name) => thread.options.linked.tools.find((item) => item.name === name);
  const opened = await runTool(tool("chat_open"), { project: "project", title: "Fix flaky terminal-perf test", prompt: "Fix it" });
  assert.equal(opened.isError, false, opened.text);
  const chatKey = /^Opened (\S+):/.exec(opened.text)[1];
  assert.equal(chatKey.startsWith(`${project}#`), true);
  const sessionId = Number(chatKey.split("#").at(-1));
  const inWorktree = (turn) => turn.cwd.startsWith(path.join(dir, "worktrees"));
  await waitUntil(() => turns.some(inWorktree));
  assert.equal(turns.find(inWorktree).permissionMode, "bot");
  assert.equal(turns.find(inWorktree).prompt, "Fix it");
  assert.equal(runtime.isQuietChat(chatKey), true);
  assert.equal(runtime.isQuietChat(`${project}#999`), false);
  // Its first turn ends at once: the Chat is done and the bot's thread hears about it.
  await eventually(async () => (await runtime.invoke("bots:list")).chats.find((chat) => chat.chatKey === chatKey)?.status === "done");
  await eventually(async () =>
    (await runtime.invoke("chat:all-messages", [bot.homePath])).some(
      (message) => message.context?.kind === "bot-chat-finished" && message.context.chatKey === chatKey,
    ),
  );
  assert.equal((await runtime.invoke("project:snapshot", [project])).state.sessions[sessionId].title, "Fix flaky terminal-perf test");
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId, body: "I'll take it", provider: "claude", model: "m", permissionMode: "auto" }]);
  assert.equal((await runtime.invoke("bots:list")).chats.find((chat) => chat.chatKey === chatKey).status, "taken-over");
  await waitUntil(() => turns.filter(inWorktree).length === 2);
  assert.equal(turns.findLast(inWorktree).permissionMode, "auto");
  const refused = await runTool(tool("chat_send"), { chat: chatKey, text: "continue" });
  assert.equal(refused.isError, true);
  assert.equal(refused.text, "Victor took over this Chat.");
  // The bot's thread stays quiet; the Chat is the user's now and announces its ends again.
  assert.equal(runtime.isQuietChat(`${bot.homePath}#${bot.threadSessionId}`), true);
  assert.equal(runtime.isQuietChat(chatKey), false);
  const chatSession = sessions.find((item) => item.options.cwd !== bot.homePath && inWorktree({ cwd: item.options.cwd }));
  assert.equal(chatSession.options.permissionPolicy({ tool: "Bash", command: "gh pr merge 1" }), undefined);
});

test("with bots off, sends to a bot are refused", async (t) => {
  const { runtime, bot } = await withOps(t);
  await runtime.invoke("bots:enabled:save", [false]);
  await assert.rejects(runtime.invoke("bots:send", ["ops", "hi"]), /Bots are off\./);
  await assert.rejects(
    runtime.invoke("chat:send", [{ projectPath: bot.homePath, sessionId: bot.threadSessionId, body: "hi", provider: "claude", model: "m" }]),
    /Bots are off\./,
  );
});

test("a paused bot takes no messages", async (t) => {
  const { runtime } = await withOps(t);
  assert.equal((await runtime.invoke("bots:update", ["ops", { paused: true }])).paused, true);
  await assert.rejects(runtime.invoke("bots:send", ["ops", "hi"]), /Ops is paused\./);
});

test("the profile edits the brief and the memory", async (t) => {
  const { runtime, bot } = await withOps(t);
  await runtime.invoke("bots:update", ["ops", { brief: "Watch main only.", role: "Keeps main green" }]);
  assert.equal(await fs.readFile(path.join(bot.homePath, "BRIEF.md"), "utf8"), "Watch main only.");
  assert.deepEqual(await runtime.invoke("bots:brief:read", ["ops"]), { text: "Watch main only." });
  assert.equal((await runtime.invoke("bots:list")).bots[0].role, "Keeps main green");
  await runtime.invoke("bots:memory:save", ["ops", "# Memory\n\n## Rules\n- never merge on Fridays\n"]);
  assert.match((await runtime.invoke("bots:memory:read", ["ops"])).text, /- never merge on Fridays <!-- victor -->/);
});

test("bots come back after a restart", async (t) => {
  const { runtime, make, bot } = await withOps(t);
  await runtime.close();
  const second = make();
  assert.deepEqual(
    (await second.invoke("bots:list")).bots.map((item) => item.id),
    ["ops"],
  );
  await second.invoke("bots:send", ["ops", "Still there?"]);
  assert.equal(
    second.snapshot().projects.some((item) => item.path === bot.homePath),
    false,
  );
});

test("deleting a bot moves its home to the trash", async (t) => {
  const { runtime, bot, dataDir } = await withOps(t);
  await runtime.invoke("bots:remove", ["ops"]);
  assert.deepEqual((await runtime.invoke("bots:list")).bots, []);
  await assert.rejects(fs.stat(bot.homePath), { code: "ENOENT" });
  const trash = await fs.readdir(path.join(await fs.realpath(dataDir), "bots", ".trash"));
  assert.equal(trash.length, 1);
  assert.match(trash[0], /^ops-\d+$/);
  // The name is free again.
  await runtime.invoke("bots:create", [{ templateId: "ops", name: "Ops", answers: { projects: bot.projects }, provider: "claude", model: "m" }]);
});
