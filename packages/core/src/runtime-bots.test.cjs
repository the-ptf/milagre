const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");
const { runTool } = require("./linked-tools.cjs");

// A Project with one commit, and fake agents that record each turn they are asked to start. `before` prepares the
// data folder before the first runtime starts.
async function fixture(t, { before = async () => {} } = {}) {
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
            // A turn asked to keep working is still running when the test quits.
            if (!/Keep working/.test(request.prompt ?? "")) options.emit({ type: "turn-completed" });
            return { turnId: "t" };
          },
          answers: [],
          respondToPermission: (requestId, decision) => {
            session.answers.push([requestId, decision]);
            return true;
          },
          setPermissionMode: async (mode) => {
            session.permissions.mode = mode;
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
  await before(dataDir);
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

test("Milagre runs without bots when angelo.db can't be opened", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { runtime, project, turns, input } = await fixture(t, { before: (dataDir) => fs.mkdir(path.join(dataDir, "angelo.db"), { recursive: true }) });
  assert.match(String(warn.mock.calls.find((call) => /angelo\.db/.test(call.arguments[0]))?.arguments[0]), /Bots are unavailable/);
  // Chats run as ever.
  const { state } = await runtime.invoke("project:snapshot", [project]);
  const worktreeId = Object.values(state.worktrees).find((worktree) => worktree.path === project).id;
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: null, worktreeId, body: "hi", provider: "claude", model: "m" }]);
  await waitUntil(() => turnIn(turns, project));
  // Bots read as off, and saying why; anything more says why too.
  const unavailable = "Bots aren't available: Milagre couldn't open angelo.db.";
  assert.deepEqual(await runtime.invoke("bots:enabled:read"), { enabled: false });
  assert.deepEqual(await runtime.invoke("bots:list"), { enabled: false, unavailable, bots: [], gates: [], grants: [], chats: [] });
  await assert.rejects(runtime.invoke("bots:enabled:save", [true]), { message: unavailable });
  await assert.rejects(runtime.invoke("bots:create", [input]), { message: unavailable });
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

test("chat:send into a bot thread is forced to Bot rules, on the bot's agent and model", async (t) => {
  const { runtime, bot, turns, sessions } = await withOps(t);
  await runtime.invoke("chat:send", [
    {
      projectPath: bot.homePath,
      sessionId: bot.threadSessionId,
      worktreeId: bot.homeWorktreeId,
      body: "hi",
      provider: "codex",
      model: "m",
      permissionMode: "full",
    },
  ]);
  await waitUntil(() => turnIn(turns, bot.homePath));
  assert.equal(turnIn(turns, bot.homePath).permissionMode, "bot");
  assert.equal(turnIn(turns, bot.homePath).model, "claude-sonnet");
  assert.deepEqual(
    sessions.filter((item) => item.options.cwd === bot.homePath).map((item) => item.provider),
    ["claude"],
  );
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
  assert.equal((await runtime.invoke("bots:answer-gate", [`${bot.homePath}#${bot.threadSessionId}`, "r1", "once"])).status, "allowed");
  assert.deepEqual(session.answers, [["r1", "allow"]]);
  // Projects' own Chats get no policy.
  assert.equal(
    sessions.filter((item) => item.options.cwd !== bot.homePath).every((item) => item.options.permissionPolicy === undefined),
    true,
  );
});

test("the user sending in a bot Chat takes it over", async (t) => {
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
  assert.equal(refused.text, "The user took over this Chat.");
  // The bot's thread stays quiet; the Chat is the user's now and announces its ends again.
  assert.equal(runtime.isQuietChat(`${bot.homePath}#${bot.threadSessionId}`), true);
  assert.equal(runtime.isQuietChat(chatKey), false);
  const chatSession = sessions.find((item) => item.options.cwd !== bot.homePath && inWorktree({ cwd: item.options.cwd }));
  assert.equal(chatSession.options.permissionPolicy({ tool: "Bash", command: "gh pr merge 1" }), undefined);
});

const names = (session) => session.options.linked.tools.map((tool) => tool.name);

test("a bot's thread and the Chats it opened can't create or start other Chats", async (t) => {
  const { runtime, bot, project, sessions, dir } = await withOps(t);
  // An ordinary Chat keeps Milagre's Chat tools.
  const { state } = await runtime.invoke("project:snapshot", [project]);
  const worktreeId = Object.values(state.worktrees).find((worktree) => worktree.path === project).id;
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: null, worktreeId, body: "hi", provider: "claude", model: "m" }]);
  await waitUntil(() => sessions.some((item) => item.options.cwd === project));
  const own = names(sessions.find((item) => item.options.cwd === project));
  assert.ok(own.includes("chat_create") && own.includes("chat_start"), own.join(", "));
  await runtime.invoke("bots:send", ["ops", "Fix the flaky test"]);
  await waitUntil(() => sessions.some((item) => item.options.cwd === bot.homePath));
  const thread = sessions.find((item) => item.options.cwd === bot.homePath);
  assert.ok(names(thread).includes("chat_open"));
  assert.ok(names(thread).includes("chat_read"));
  assert.equal(names(thread).includes("chat_create") || names(thread).includes("chat_start"), false);
  const opened = await runTool(
    thread.options.linked.tools.find((item) => item.name === "chat_open"),
    { project: "project", title: "Fix flaky terminal-perf test", prompt: "Fix it" },
  );
  assert.equal(opened.isError, false, opened.text);
  await waitUntil(() => sessions.some((item) => item.options.cwd.startsWith(path.join(dir, "worktrees"))));
  const chat = names(sessions.find((item) => item.options.cwd.startsWith(path.join(dir, "worktrees"))));
  assert.equal(chat.includes("chat_create") || chat.includes("chat_start"), false, chat.join(", "));
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
  const { text } = await runtime.invoke("bots:memory:read", ["ops"]);
  assert.match(text, /- never merge on Fridays <!-- user -->/);
  // A save from what the profile read: refused once the file changed since.
  await runtime.invoke("bots:memory:save", ["ops", `${text}- ship on Mondays\n`, text]);
  await assert.rejects(runtime.invoke("bots:memory:save", ["ops", `${text}- ship on Tuesdays\n`, text]), /MEMORY\.md changed since you opened it\./);
  assert.match((await runtime.invoke("bots:memory:read", ["ops"])).text, /- ship on Mondays <!-- user -->\n$/);
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

// A bot's thread whose turn the quit stopped, in a second runtime after the restart; `before` changes the bot first.
async function restartMidTurn(t, before = async () => {}) {
  const f = await withOps(t);
  await f.runtime.invoke("bots:send", ["ops", "Keep working"]);
  await waitUntil(() => turnIn(f.turns, f.bot.homePath));
  await before(f.runtime);
  await f.runtime.close();
  const started = f.turns.length;
  const second = f.make();
  const thread = () =>
    second.invoke("project:snapshot", [f.bot.homePath]).then(
      ({ state }) => state.sessions[f.bot.threadSessionId],
      () => null,
    );
  await eventually(thread);
  return { ...f, second, started, thread };
}

test("an active bot's interrupted turn continues after a restart", async (t) => {
  const { turns, started, bot } = await restartMidTurn(t);
  await waitUntil(() => turns.length > started);
  assert.equal(turns.at(-1).cwd, bot.homePath);
  assert.equal(turns.at(-1).permissionMode, "bot");
});

for (const [name, before] of [
  ["a paused bot", (runtime) => runtime.invoke("bots:update", ["ops", { paused: true }])],
  ["a bot with Bots off", (runtime) => runtime.invoke("bots:enabled:save", [false])],
])
  test(`${name} doesn't continue its interrupted turn after a restart`, async (t) => {
    const { second, turns, started, thread, bot } = await restartMidTurn(t, before);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(turns.length, started);
    assert.ok((await thread()).resumeTurn, "the turn waits to be continued");
    // Continuing it by hand is a message to the bot too.
    await assert.rejects(second.invoke("chat:resume", [bot.homePath, bot.threadSessionId]), /Ops is paused\.|Bots are off\./);
    assert.equal(turns.length, started);
  });

// A Chat Ops opened whose turn is still running when the first runtime quits.
async function botChatMidTurn(t) {
  const f = await withOps(t);
  await f.runtime.invoke("bots:send", ["ops", "Fix the flaky test"]);
  await waitUntil(() => f.sessions.some((item) => item.options.cwd === f.bot.homePath));
  const thread = f.sessions.find((item) => item.options.cwd === f.bot.homePath);
  const opened = await runTool(
    thread.options.linked.tools.find((item) => item.name === "chat_open"),
    { project: "project", title: "Fix flaky terminal-perf test", prompt: "Keep working" },
  );
  assert.equal(opened.isError, false, opened.text);
  const chatKey = /^Opened (\S+):/.exec(opened.text)[1];
  await waitUntil(() => f.turns.some((turn) => turn.cwd.startsWith(path.join(f.dir, "worktrees"))));
  await f.runtime.close();
  return { ...f, chatKey, sessionId: Number(chatKey.split("#").at(-1)) };
}
// A Chat Ops opened whose turn still runs, in Bot rules, in the first runtime.
async function runningBotChat(t) {
  const f = await withOps(t);
  await f.runtime.invoke("bots:send", ["ops", "Fix the flaky test"]);
  await waitUntil(() => f.sessions.some((item) => item.options.cwd === f.bot.homePath));
  const thread = f.sessions.find((item) => item.options.cwd === f.bot.homePath);
  const tool = (name) => thread.options.linked.tools.find((item) => item.name === name);
  const opened = await runTool(tool("chat_open"), { project: "project", title: "Fix flaky terminal-perf test", prompt: "Keep working" });
  assert.equal(opened.isError, false, opened.text);
  const chatKey = /^Opened (\S+):/.exec(opened.text)[1];
  const inWorktree = (item) => item.options.cwd.startsWith(path.join(f.dir, "worktrees"));
  await waitUntil(() => f.sessions.some(inWorktree));
  const session = f.sessions.find(inWorktree);
  assert.equal(session.permissions.mode, "bot");
  return { ...f, chatKey, session, tool, sessionId: Number(chatKey.split("#").at(-1)) };
}

test("deleting a bot takes its running Chats out of Bot rules", async (t) => {
  const { runtime, session } = await runningBotChat(t);
  await runtime.invoke("bots:remove", ["ops"]);
  assert.equal(session.permissions.mode, "ask");
});

test("the user's message in a bot Chat never runs in Bot rules", async (t) => {
  const { runtime, project, sessionId, session, turns, dir } = await runningBotChat(t);
  // The composer sends the run's mode, Bot rules.
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId, body: "I'll take it", provider: "claude", model: "m", permissionMode: "bot" }]);
  assert.equal(session.permissions.mode, "ask");
  await waitUntil(() => turns.filter((turn) => turn.cwd.startsWith(path.join(dir, "worktrees"))).length === 2);
  assert.equal(turns.at(-1).permissionMode, "ask");
  // Nor does any Chat that isn't a bot's.
  const { state } = await runtime.invoke("project:snapshot", [project]);
  const worktreeId = Object.values(state.worktrees).find((worktree) => worktree.path === project).id;
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: null, worktreeId, body: "hi", provider: "claude", model: "m", permissionMode: "bot" }]);
  await waitUntil(() => turns.at(-1).cwd === project);
  assert.equal(turns.at(-1).permissionMode, "ask");
});

test("no client sets Bot rules, nor changes a bot thread's mode", async (t) => {
  const { runtime, bot, project, sessions } = await withOps(t);
  const { state } = await runtime.invoke("project:snapshot", [project]);
  const worktreeId = Object.values(state.worktrees).find((worktree) => worktree.path === project).id;
  const { sessionId } = await runtime.invoke("chat:send", [{ projectPath: project, sessionId: null, worktreeId, body: "hi", provider: "codex", model: "m" }]);
  await waitUntil(() => sessions.some((item) => item.options.cwd === project));
  await assert.rejects(
    runtime.invoke("agent:set-permission-mode", [{ chatId: `${project}#${sessionId}`, mode: "bot" }]),
    /Only a bot's Chats run in Bot rules\./,
  );
  assert.notEqual(sessions.find((item) => item.options.cwd === project).permissions.mode, "bot");
  await runtime.invoke("bots:send", ["ops", "hi"]);
  await waitUntil(() => sessions.some((item) => item.options.cwd === bot.homePath));
  await assert.rejects(
    runtime.invoke("agent:set-permission-mode", [{ chatId: `${bot.homePath}#${bot.threadSessionId}`, mode: "full" }]),
    /Ops's thread always runs in Bot rules\./,
  );
  assert.equal(sessions.find((item) => item.options.cwd === bot.homePath).permissions.mode, "bot");
});

// A sign-off card published in the running bot Chat, as its session would; `expiresAt` defaults to an hour from now.
async function signOffIn(f, requestId, expiresAt = Date.now() + 3_600_000) {
  const { gate } = f.session.options.permissionPolicy({ tool: "Bash", command: "gh pr merge 1" });
  f.session.options.emit({
    type: "permission-request",
    requestId,
    kind: "command",
    tool: "Bash",
    command: "gh pr merge 1",
    title: "x",
    gate: { ...gate, expiresAt },
  });
  await eventually(async () => (await f.runtime.invoke("bots:list")).gates.some((item) => item.requestId === requestId));
}
const gateStatus = async (runtime, requestId) => (await runtime.invoke("bots:list")).gates.find((gate) => gate.requestId === requestId).status;

test("changing a bot Chat's mode takes it over, and its sign-offs are denied", async (t) => {
  const f = await runningBotChat(t);
  await signOffIn(f, "r1");
  await f.runtime.invoke("agent:set-permission-mode", [{ chatId: f.chatKey, mode: "full" }]);
  assert.equal(await chatStatus(f.runtime, f.chatKey), "taken-over");
  assert.equal(await gateStatus(f.runtime, "r1"), "denied");
  assert.deepEqual(f.session.answers, [["r1", "deny"]]);
  assert.equal(f.session.permissions.mode, "full");
});

test("a sign-off card answered in its Chat goes through the sign-off", async (t) => {
  const f = await runningBotChat(t);
  await signOffIn(f, "r1", Date.now() - 1);
  assert.equal(await f.runtime.invoke("agent:respond-permission", [{ chatId: f.chatKey, requestId: "r1", decision: "allow" }]), false);
  assert.equal(await gateStatus(f.runtime, "r1"), "expired");
  assert.deepEqual(f.session.answers, [["r1", "deny"]]);
  await signOffIn(f, "r2");
  assert.equal(await f.runtime.invoke("agent:respond-permission", [{ chatId: f.chatKey, requestId: "r2", decision: "allow-for-chat" }]), true);
  assert.equal(await gateStatus(f.runtime, "r2"), "allowed");
  assert.deepEqual(f.session.answers.at(-1), ["r2", "allow"]);
});

const chatStatus = async (runtime, chatKey) => (await runtime.invoke("bots:list")).chats.find((chat) => chat.chatKey === chatKey)?.status;

test("a bot Chat the quit stopped still runs after the restart", async (t) => {
  const { make, chatKey } = await botChatMidTurn(t);
  const second = make();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await chatStatus(second, chatKey), "running");
});

test("a bot Chat that won't resume after the restart is failed", async (t) => {
  const { make, chatKey, sessionId, project, turns, bot } = await botChatMidTurn(t);
  // Stopped longer ago than a resume waits for.
  const file = path.join(project, ".milagre", "coordination.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(saved.sessions[sessionId].resumeTurn);
  saved.sessions[sessionId].resumeTurn.stoppedAt = 0;
  await fs.writeFile(file, JSON.stringify(saved));
  const threadTurns = turns.filter((turn) => turn.cwd === bot.homePath).length;
  const second = make();
  await eventually(async () => (await chatStatus(second, chatKey)) === "failed");
  // Nothing is said in the bot's thread at boot.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(turns.filter((turn) => turn.cwd === bot.homePath).length, threadTurns);
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
