const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRoutines, routineChats, routineReply } = require("./runtime-adapter.cjs");

const chatId = "/project#2";
const baseState = {
  sessions: { 2: { id: 2, worktree_id: 1, provider: "codex" }, 3: { id: 3, worktree_id: 1, archived: true } },
  messages: [
    { id: 1, session_id: 2, role: "user", body: "Watch CI", context: null, model: "gpt-x" },
    { id: 2, session_id: 2, role: "assistant", body: "(pass) old beat", context: null },
    { id: 3, session_id: 2, role: "user", body: "Check CI", context: { kind: "routine-run", runId: "run-1" }, model: "gpt-x" },
    { id: 4, session_id: 2, role: "assistant", body: "Note", context: { kind: "git-action" } },
    { id: 5, session_id: 2, role: "assistant", body: "  (pass) CI green  ", context: null },
  ],
};

// `sessionMode` is the permission mode saved on the Chat (AgentSession.permissionMode), as the composer last set it.
function fixture({ turnSettings = null, sessionMode, runs = {}, busy = false, open = true } = {}) {
  const sent = [];
  const patched = [];
  const state = sessionMode ? { ...baseState, sessions: { ...baseState.sessions, 2: { ...baseState.sessions[2], permissionMode: sessionMode } } } : baseState;
  const chats = {
    runs,
    isBusy: () => busy,
    turnSettings: () => turnSettings,
    send: async (request) => {
      sent.push(request);
      return { sessionId: request.sessionId, started: Promise.resolve({ turnId: "t" }) };
    },
    patchMessageContext: async (...args) => {
      patched.push(args);
      return true;
    },
  };
  const adapter = routineChats({
    chats,
    cachedState: (scope) => (open && scope === "/project" ? state : undefined),
    openState: async () => state,
    isClosing: () => false,
  });
  return { adapter, sent, patched };
}

test("a Chat in a Project not open yet counts as there, so it is never swept as gone", () => {
  const { adapter } = fixture({ open: false });
  assert.equal(adapter.exists(chatId), true);
  assert.equal(adapter.archived(chatId), false);
  const opened = fixture().adapter;
  assert.equal(opened.exists(chatId), true);
  assert.equal(opened.exists("/project#9"), false);
  assert.equal(opened.archived("/project#3"), true);
});

test("busy covers a running turn and an approval or question waiting", () => {
  assert.equal(fixture({ busy: true }).adapter.busy(chatId), true);
  assert.equal(fixture().adapter.busy(chatId), false);
  assert.equal(fixture({ runs: { [chatId]: { approvals: [{}], questions: [] } } }).adapter.busy(chatId), true);
  assert.equal(fixture({ runs: { [chatId]: { approvals: [], questions: [{}] } } }).adapter.busy(chatId), true);
});

// A Chat the adapter sees through `cachedState`, with what ChatHost knows about it in memory.
function idleFixture({ session = {}, startingTurns = new Map(), runs = {}, send } = {}) {
  const sent = [];
  const chatState = {
    sessions: { 2: { id: 2, worktree_id: 1, provider: "claude", ...session } },
    messages: [{ id: 1, session_id: 2, role: "user", body: "Watch CI", context: null, model: "opus" }],
  };
  const chats = {
    runs,
    startingTurns,
    isBusy: () => false,
    turnSettings: () => null,
    send:
      send ??
      (async (request) => {
        sent.push(request);
        return { sessionId: 2, started: Promise.resolve({ turnId: "t" }) };
      }),
  };
  const adapter = routineChats({
    chats,
    cachedState: (scope) => (scope === "/project" ? chatState : undefined),
    openState: async () => chatState,
    isClosing: () => false,
  });
  return { adapter, sent, chats };
}
const running = (id, background = true) => ({ id, background, status: "running" });

test("busy also covers a turn starting, a message waiting in the queue, and background work that comes back to the Chat", () => {
  assert.equal(idleFixture().adapter.busy(chatId), false);
  assert.equal(idleFixture({ startingTurns: new Map([[chatId, "antigravity"]]) }).adapter.busy(chatId), true);
  assert.equal(idleFixture({ session: { queued: [{ id: "q1", body: "next" }] } }).adapter.busy(chatId), true);
  // #491: a turn's end isn't the end of its work while its background agents run; their results wake the Chat.
  assert.equal(idleFixture({ session: { subagents: [running("a1")] } }).adapter.busy(chatId), true);
  assert.equal(idleFixture({ session: { subagents: [{ ...running("a1"), status: "completed" }] } }).adapter.busy(chatId), false);
  assert.equal(idleFixture({ session: { subagents: [{ id: "adv", source: "milagre-advisor", status: "running" }] } }).adapter.busy(chatId), true);
  // A command left running in the background (a dev server) never ends: it doesn't hold the heartbeat back.
  assert.equal(
    idleFixture({ session: { backgroundTasks: [{ id: "b1", kind: "local_bash", title: "npm run dev", startedAt: 1 }] } }).adapter.busy(chatId),
    false,
  );
  assert.equal(idleFixture({ session: { backgroundTasks: [{ id: "m1", kind: "mcp", title: "build", startedAt: 1 }] } }).adapter.busy(chatId), true);
});

test("a beat checks the Chat again as its message is saved, and never waits in the Chat's queue", async () => {
  const { adapter, sent } = idleFixture();
  await adapter.send(chatId, { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1", runId: "run-9" } });
  // ChatHost never queues a send that carries canStart (see ChatHost.send).
  assert.equal(typeof sent[0].canStart, "function");
  assert.equal(sent[0].canStart(), true);
});

test("a beat whose Chat got busy while it was being sent rejects as busy, not as a failure", async () => {
  const fixtureState = {};
  const { adapter, chats } = idleFixture({
    send: async (request) => {
      // The user's turn started while the beat waited on the Project: ChatHost asks canStart as it saves.
      chats.runs[chatId] = { approvals: [], questions: [] };
      if (!request.canStart()) throw new Error("Advisor delivery is deferred.");
      fixtureState.saved = true;
      return { sessionId: 2, started: Promise.resolve({ turnId: "t" }) };
    },
  });
  chats.isBusy = (id) => Boolean(chats.runs[id]);
  await assert.rejects(
    adapter.send(chatId, { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1", runId: "run-9" } }),
    (error) => error.busy === true,
  );
  assert.equal(fixtureState.saved, undefined);
});

test("a beat into a Chat whose turn started as its Project opened rejects as busy before anything is saved", async () => {
  const sent = [];
  const startingTurns = new Map();
  const { adapter } = idleFixture({
    startingTurns,
    send: async (request) => {
      sent.push(request);
      return { sessionId: 2, started: Promise.resolve({ turnId: "t" }) };
    },
  });
  startingTurns.set(chatId, "claude");
  await assert.rejects(
    adapter.send(chatId, { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1", runId: "run-9" } }),
    (error) => error.busy === true,
  );
  assert.equal(sent.length, 0);
});

test("after a restart a beat runs on the Chat's own provider and last model, and the mode its composer last set", async () => {
  const { adapter, sent } = fixture({ sessionMode: "ask" });
  const context = { kind: "routine-run", routineId: "r1", runId: "run-2" };
  const settings = { provider: "claude", model: "cm", permissionMode: "full" };
  const { started } = await adapter.send(chatId, { body: "Check CI", prompt: "Check CI + hint", context, settings });
  assert.deepEqual(await started, { turnId: "t" });
  assert.equal(sent[0].provider, "codex");
  assert.equal(sent[0].model, "gpt-x");
  // Saved on the Chat, so it outlives the restart; the mode the Run was claimed with is only the last resort.
  assert.equal(sent[0].permissionMode, "ask");
  assert.equal(sent[0].projectPath, "/project");
  assert.equal(sent[0].sessionId, 2);
  assert.equal(sent[0].worktreeId, 1);
  assert.equal(sent[0].prompt, "Check CI + hint");
  assert.equal(sent[0].context, context);
});

test("a beat keeps the Chat's latest turn settings when it has some", async () => {
  const { adapter, sent } = fixture({ turnSettings: { provider: "claude", model: "opus", permissionMode: "plan", effort: "high" } });
  await adapter.send(chatId, { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1" } });
  assert.equal(sent[0].provider, "claude");
  assert.equal(sent[0].model, "opus");
  assert.equal(sent[0].effort, "high");
  // The Chat's current mode, not the one it had when the heartbeat was set.
  assert.equal(sent[0].permissionMode, "plan");
});

test("a beat with neither turn settings nor a stored mode runs in auto", async () => {
  const { adapter, sent } = fixture();
  await adapter.send(chatId, { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "missing" } });
  assert.equal(sent[0].permissionMode, "auto");
});

test("a beat into a Chat that's gone fails", async () => {
  const { adapter } = fixture();
  await assert.rejects(adapter.send("/project#9", { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1" } }), /no longer in its Project/);
});

test("the reply is the last saved reply after the latest divider, notes left out", () => {
  assert.equal(fixture({ runs: { [chatId]: { text: "(pass) live" } } }).adapter.replyText(chatId), "(pass) CI green");
  assert.equal(routineReply({ messages: [{ session_id: 2, role: "assistant", body: "(pass) x", context: null }] }, 2), "");
});

const beat = (...replies) => ({
  messages: [{ id: 1, session_id: 2, role: "user", body: "Check CI", context: { kind: "routine-run", runId: "r" } }, ...replies],
});
const reply = (body, steps = []) => ({ session_id: 2, role: "assistant", context: null, body, steps });

test("only the text after the turn's last tool step counts", () => {
  // "Let me check CI." → a tool call → "(pass) CI green", saved as one body with the step's offset.
  const passed = beat(reply("Let me check CI.(pass) CI green", [{ id: "s1", kind: "shell", offset: 16 }]));
  assert.equal(routineReply(passed, 2), "(pass) CI green");
  const acted = beat(reply("(pass) looks fine at first.Actually CI failed, fixing it.", [{ id: "s1", kind: "shell", offset: 27 }]));
  assert.equal(routineReply(acted, 2), "Actually CI failed, fixing it.");
  // Thinking isn't a tool step; a turn that ends on a tool step said nothing after it.
  assert.equal(routineReply(beat(reply("(pass) ok", [{ id: "t", kind: "thinking", offset: 9 }])), 2), "(pass) ok");
  assert.equal(routineReply(beat(reply("(pass) ok", [{ id: "s", kind: "shell", offset: 9 }])), 2), "");
});

test("a turn a steering message split into several replies ends with the last of them", () => {
  const split = beat(reply("(pass) nothing yet"), { session_id: 2, role: "user", body: "also check deploys", context: null }, reply("Deploy is broken."));
  assert.equal(routineReply(split, 2), "Deploy is broken.");
  const passedLast = beat(reply("Looking."), reply("(pass) all green"));
  assert.equal(routineReply(passedLast, 2), "(pass) all green");
});

test("patchRunContext patches the divider of that Run", async () => {
  const { adapter, patched } = fixture();
  await adapter.patchRunContext(chatId, "run-1", { quiet: true, summary: "CI green" });
  const [[projectPath, sessionId, match, patch]] = patched;
  assert.equal(projectPath, "/project");
  assert.equal(sessionId, 2);
  assert.deepEqual(patch, { quiet: true, summary: "CI green" });
  assert.deepEqual(
    baseState.messages.filter(match).map((message) => message.id),
    [3],
  );
});

test("patchRunContext hands a session patch on", async () => {
  const { adapter, patched } = fixture();
  await adapter.patchRunContext(chatId, "run-1", { quiet: true }, { unread: false });
  assert.deepEqual(patched[0][4], { unread: false });
});

test("a Chat on a Named Link gets no routine tools", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const routines = createRoutines({
    file: path.join(dir, "routines.json"),
    chats: { turnSettings: () => null },
    keepAwake: { setRoutinesActive() {} },
    emit() {},
    cachedState: () => undefined,
    openState: async () => undefined,
  });
  assert.equal(routines.definitions("/project#2").length, 6);
  assert.deepEqual(routines.definitions("milagre-link:0f8e2c1a-1b2c-4d5e-8f90-123456789abc#2"), []);
});

// The adapter's half of a Run in a Chat of its own: Worktrees and Chats faked, with what each call got.
function newChatFixture({ removable = true, failChat = false, createDelayMs = 0, timeoutMs } = {}) {
  const calls = { created: [], removed: [], archived: [], emptyChats: [] };
  const projectState = {
    worktrees: { 1: { id: 1, path: "/project" }, 7: { id: 7, path: "/worktrees/seven", base: "main" } },
    sessions: { 4: { id: 4, worktree_id: 7 } },
    messages: [],
  };
  const sent = [];
  const chats = {
    runs: {},
    isBusy: () => false,
    turnSettings: () => null,
    send: async (request) => {
      sent.push(request);
      return { sessionId: request.sessionId, started: Promise.resolve({ turnId: "t" }) };
    },
    emptyChat: async (projectPath, worktreeId, options) => {
      calls.emptyChats.push({ projectPath, worktreeId, options });
      if (failChat) throw new Error("no chat");
      return 4;
    },
  };
  const worktrees = {
    create: async (args) => {
      calls.created.push(args);
      if (createDelayMs) await new Promise((resolve) => setTimeout(resolve, createDelayMs));
      return { worktreeId: 7 };
    },
    remove: async (...args) => {
      calls.removed.push(args);
    },
    removable: async () => removable,
    base: async () => "main",
    projectWorktree: async () => 1,
  };
  const adapter = routineChats({
    chats,
    cachedState: (scope) => (scope === "/project" ? projectState : undefined),
    openState: async () => projectState,
    isClosing: () => false,
    worktrees,
    archiveChat: async (chatId) => calls.archived.push(chatId),
    now: () => Date.UTC(2026, 9, 16, 11, 5),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { adapter, calls, sent };
}

const triage = (workspace = "worktree", trigger = { kind: "schedule", cron: "0 8 * * *", timezone: "America/Sao_Paulo" }) => ({
  id: "r9",
  name: "Morning triage",
  prompt: "Triage on {{date}} at {{time}}",
  trigger,
  target: { kind: "new-chat", projectPath: "/project", workspace },
});

test("a schedule Run in a new Worktree makes the Worktree and a Chat marked with its Run, and words the first message", async () => {
  const { adapter, calls } = newChatFixture();
  const chat = await adapter.startChat({ routine: triage(), run: { id: "run-5" } });
  assert.deepEqual(calls.created, [{ projectPath: "/project", baseBranch: "main", prompt: "" }]);
  assert.equal(calls.emptyChats[0].worktreeId, 7);
  assert.deepEqual(calls.emptyChats[0].options.origin, { routineId: "r9", runId: "run-5" });
  assert.equal(calls.emptyChats[0].options.title, "Morning triage");
  assert.equal(chat.chatId, "/project#4");
  assert.equal(chat.worktreeId, "7");
  assert.equal(chat.createdWorktree, true);
  // 11:05 UTC is 08:05 in São Paulo.
  assert.equal(chat.body, "Triage on 2026-10-16 at 08:05");
  assert.equal(chat.prompt, chat.body);
  assert.deepEqual(chat.context, {
    kind: "routine-run",
    routineId: "r9",
    runId: "run-5",
    name: "Morning triage",
    at: Date.UTC(2026, 9, 16, 11, 5),
    label: "Routine · Morning triage",
  });
});

test("a Run in the Project folder makes no Worktree and a fresh Chat in the main checkout", async () => {
  const { adapter, calls } = newChatFixture();
  const chat = await adapter.startChat({ routine: triage("project"), run: { id: "run-6" } });
  assert.deepEqual(calls.created, []);
  assert.equal(calls.emptyChats[0].worktreeId, 1);
  assert.equal(calls.emptyChats[0].options.fresh, true);
  assert.equal(chat.createdWorktree, false);
  assert.equal(chat.worktreeId, "1");
});

test("a Chat that can't be made takes its new Worktree with it", async () => {
  const { adapter, calls } = newChatFixture({ failChat: true });
  await assert.rejects(adapter.startChat({ routine: triage(), run: { id: "run-7" } }), /no chat/);
  assert.deepEqual(calls.removed, [["/project", 7]]);
});

test("a Worktree that takes too long fails the Run, and goes once it is made", async () => {
  const { adapter, calls } = newChatFixture({ createDelayMs: 40, timeoutMs: 5 });
  await assert.rejects(adapter.startChat({ routine: triage(), run: { id: "run-8" } }), /took too long/);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(calls.removed, [["/project", 7]]);
  assert.deepEqual(calls.emptyChats, []);
});

test("a webhook Run isn't supported yet", async () => {
  const { adapter, calls } = newChatFixture();
  await assert.rejects(
    adapter.startChat({
      routine: triage("worktree", { kind: "webhook", hookId: "h", signed: false }),
      run: { id: "r", event: { kind: "webhook", key: "k", deliveryId: "d" } },
    }),
    /Webhook Routines arrive in a later update/,
  );
  assert.deepEqual(calls.created, []);
});

test("a Linear Run makes the issue's Worktree and names the Chat after the issue", async () => {
  const { adapter, calls } = newChatFixture();
  const issue = { id: "i", key: "MIL-1", title: "Paste images", description: "d", url: "u", labels: [], state: "Todo", team: "MIL", workspace: "w1" };
  const routine = { ...triage("worktree", { kind: "linear", workspace: "w1", event: "assigned" }), prompt: "Work on {{issue.key}}: {{issue.title}}" };
  const chat = await adapter.startChat({ routine, run: { id: "run-9", event: { kind: "linear", key: "linear:i:h", change: "assigned", issue } } });
  assert.deepEqual(calls.created, [{ projectPath: "/project", baseBranch: "main", prompt: "", issueKey: "MIL-1", issueWorkspace: "w1" }]);
  assert.equal(calls.emptyChats[0].options.title, "MIL-1 Paste images");
  // The title is fenced as data, the key goes in as it is.
  assert.ok(chat.body.endsWith('Work on MIL-1: <untrusted-data source="Linear issue MIL-1 title">Paste images</untrusted-data>'));
});

test("archive removes the Run's Worktree only when asked and it has nothing to keep", async () => {
  const clean = newChatFixture();
  await clean.adapter.archive("/project#4", { removeWorktree: true });
  assert.deepEqual(clean.calls.archived, ["/project#4"]);
  assert.deepEqual(clean.calls.removed, [["/project", 7, "/project#4"]]);

  const dirty = newChatFixture({ removable: false });
  await dirty.adapter.archive("/project#4", { removeWorktree: true });
  assert.deepEqual(dirty.calls.archived, ["/project#4"]);
  assert.deepEqual(dirty.calls.removed, []);

  const kept = newChatFixture();
  await kept.adapter.archive("/project#4", { removeWorktree: false });
  assert.deepEqual(kept.calls.removed, []);
});

test("a Chat a Routine started gets no tools that make or start Routines", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = { 2: { id: 2 }, 3: { id: 3, routine: { routineId: "r", runId: "run" } } };
  const routines = createRoutines({
    file: path.join(dir, "routines.json"),
    chats: { turnSettings: () => null },
    keepAwake: { setRoutinesActive() {} },
    emit() {},
    cachedState: () => ({ sessions }),
    openState: async () => undefined,
  });
  const names = (chatId) => routines.definitions(chatId).map((tool) => tool.name);
  assert.ok(names("/project#2").includes("heartbeat_create"));
  assert.ok(names("/project#2").includes("routine_run_now"));
  for (const name of ["heartbeat_create", "routine_create", "routine_run_now"]) assert.ok(!names("/project#3").includes(name), name);
  assert.ok(names("/project#3").includes("routine_list"));
});

// The runtime makes Linear after the Routines: a getter read too early throws, which must not break anything.
function linearRoutines(t, linear, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const timers = [];
  const routines = createRoutines({
    file: path.join(dir, "routines.json"),
    chats: { turnSettings: () => null },
    keepAwake: { setRoutinesActive() {} },
    emit() {},
    cachedState: () => undefined,
    openState: async () => undefined,
    linear,
    projects: async () => [{ path: "/project" }],
    timers: {
      ...(now ? { now } : {}),
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
      setTimeout(fn, ms) {
        const timer = { fn, ms, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        if (timer) timer.cleared = true;
      },
    },
  });
  return { routines, timers };
}

test("routine_create takes the one connected Linear workspace, and a Linear not made yet lists none", async (t) => {
  const fake = { enabled: () => true, workspaces: () => [{ id: "acme", organization: { name: "Acme" } }], query: async () => ({}) };
  const { routines } = linearRoutines(t, () => fake);
  await routines.save(true);
  const create = routines.definitions("/project#2").find((tool) => tool.name === "routine_create");
  await create.run({ name: "Assigned", prompt: "Look at {{issue.key}}", trigger: "linear", linearEvent: "assigned" });
  assert.equal(routines.list().routines[0].trigger.workspace, "acme");
  await routines.save(false);

  const early = linearRoutines(t, () => {
    throw new ReferenceError("Cannot access 'linear' before initialization");
  });
  await early.routines.save(true);
  const tool = early.routines.definitions("/project#2").find((item) => item.name === "routine_create");
  await assert.rejects(tool.run({ name: "A", prompt: "B", trigger: "linear", linearEvent: "assigned" }), /Say which Linear workspace/);
  await early.routines.save(false);
});

test("the Routines switch starts and stops Linear polling", async (t) => {
  const queries = [];
  const fake = {
    enabled: () => true,
    workspaces: () => [{ id: "acme", organization: { name: "Acme" } }],
    query: async (workspace, document) => {
      queries.push(workspace);
      return document.includes("PollIssues") ? { issues: { nodes: [] } } : { comments: { nodes: [] } };
    },
  };
  const { routines, timers } = linearRoutines(t, () => fake);
  await routines.create({
    name: "Assigned",
    prompt: "Look",
    trigger: { kind: "linear", workspace: "acme", event: "assigned" },
    target: { kind: "new-chat", projectPath: "/project", workspace: "worktree" },
  });
  assert.deepEqual(
    timers.filter((timer) => !timer.cleared),
    [],
    "off: nothing polls",
  );
  await routines.save(true);
  const first = timers.find((timer) => !timer.cleared && timer.ms === 0);
  assert.ok(first, "on: a poll is due at once");
  // A timer that fired is done with, as a cleared one is.
  first.cleared = true;
  await first.fn();
  // An assigned Routine needs issues only.
  assert.deepEqual(queries, ["acme"]);
  await routines.save(false);
  assert.deepEqual(
    timers.filter((timer) => !timer.cleared),
    [],
    "off again: every poll timer is cleared",
  );
});

test("Linear polling runs on the Routines' clock", async (t) => {
  const clock = Date.UTC(2020, 0, 1, 12);
  const queries = [];
  const fake = {
    enabled: () => true,
    workspaces: () => [{ id: "acme", organization: { name: "Acme" } }],
    query: async (workspace, document, variables) => {
      queries.push(variables);
      return { issues: { nodes: [] } };
    },
  };
  const { routines, timers } = linearRoutines(
    t,
    () => fake,
    () => clock,
  );
  await routines.create({
    name: "Assigned",
    prompt: "Look",
    trigger: { kind: "linear", workspace: "acme", event: "assigned" },
    target: { kind: "new-chat", projectPath: "/project", workspace: "worktree" },
  });
  await routines.save(true);
  const first = timers.find((timer) => !timer.cleared && timer.ms === 0);
  first.cleared = true;
  await first.fn();
  // 5 s before the Routine was made on that clock; on the real one this would be floored at a day ago.
  assert.equal(queries[0].since, new Date(clock - 5_000).toISOString());
  await routines.save(false);
});

// The real ChatHost on fake agents, as chat-host.test.cjs builds it: one Project with one Chat that ran a turn.
async function realChats({ beforeSend, beforeTask } = {}) {
  const { ChatHost } = require("../agents/chat-host.cjs");
  const { SessionManager } = require("../agents/session-manager.cjs");
  const { ProjectStates } = require("../project-states.cjs");
  const project = "/projects/alpha";
  const agents = [];
  const states = new ProjectStates({
    read: async () => ({
      next_id: 3,
      projects: { 1: { id: 1, name: "alpha" } },
      worktrees: { 1: { id: 1, name: "main", path: project } },
      sessions: { 2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created", provider: "claude" } },
      connections: {},
      events: [],
      messages: [{ id: 1, session_id: 2, role: "user", body: "Watch CI", context: null, model: "opus" }],
      approvals: [],
      tasks: {},
      artifacts: {},
      outputs: [],
      conflicts: [],
    }),
    save: async () => {},
  });
  let host;
  const manager = new SessionManager({
    createSession: (provider, options) => {
      const agent = {
        provider,
        options,
        turns: [],
        startTurn: async (turn) => (agent.turns.push(turn), { turnId: `t${agent.turns.length}` }),
        close: async () => {},
      };
      agents.push(agent);
      return agent;
    },
    send: (key, event) => void host.receive(key, event),
    batchMs: 5,
  });
  host = new ChatHost({
    states,
    startTurn: (request) => manager.startTurn({ ...request, command: "/bin/agent" }),
    publish: () => {},
    broadcast: () => {},
    ...(beforeSend ? { beforeSend } : {}),
    ...(beforeTask ? { beforeTask } : {}),
  });
  const adapter = routineChats({
    chats: host,
    cachedState: (scope) => states.states.get(scope),
    openState: async (scope) => states.get(scope),
    isClosing: () => false,
  });
  return { host, manager, states, agents, adapter, project, chatId: `${project}#2` };
}

test("a user's turn that starts while a beat is on its way to ChatHost makes the beat wait instead of starting beside it", async (t) => {
  const { waitUntil } = require("../agents/test-helpers.cjs");
  let releaseUser;
  const userGate = new Promise((resolve) => (releaseUser = resolve));
  let userSend;
  const ctx = await realChats({
    // The user presses Send while the beat is between its busy check and its save.
    beforeSend: async (request) => {
      if (request.context?.kind !== "routine-run") return;
      userSend = ctx.host.send({
        projectPath: ctx.project,
        sessionId: 2,
        body: "fix the test",
        images: [],
        provider: "claude",
        model: "opus",
        permissionMode: "auto",
      });
      await waitUntil(() => ctx.host.startingTurns.has(ctx.chatId));
    },
    // The user's message is saved and its turn starting, its run not made yet.
    beforeTask: async (request) => {
      if (!request.context) await userGate;
    },
  });
  t.after(() => ctx.manager.closeAll());
  await assert.rejects(
    ctx.adapter.send(ctx.chatId, {
      body: "Check CI",
      prompt: "Check CI",
      context: { kind: "routine-run", routineId: "r1", runId: "run-1", name: "Babysit", at: 1 },
    }),
    (error) => error.busy === true,
  );
  releaseUser();
  await userSend;
  await waitUntil(() => ctx.agents[0]?.turns.length === 1);
  const saved = (await ctx.states.get(ctx.project)).messages.filter((message) => message.role === "user").map((message) => message.body);
  assert.deepEqual(saved, ["Watch CI", "fix the test"]);
});

test("a Run's message carries the settings its Routine had when it was claimed, whatever the Routine says now", async () => {
  const { adapter, sent } = newChatFixture();
  // The Run's claimed settings, which an edit to the Routine since doesn't change.
  const settings = { provider: "codex", model: "gpt-6", permissionMode: "ask" };
  await adapter.send("/project#4", { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r9", runId: "run-1" }, settings });
  assert.deepEqual([sent[0].provider, sent[0].model, sent[0].permissionMode], ["codex", "gpt-6", "ask"]);
});

test("a beat takes the mode saved on the Chat over its last turn's and the claimed one; without one, the claimed mode", async () => {
  const { adapter, sent } = fixture({
    turnSettings: { provider: "claude", model: "opus", permissionMode: "full", effort: "high" },
    sessionMode: "ask",
  });
  const settings = { provider: "claude", model: "cm", permissionMode: "full" };
  await adapter.send(chatId, { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1" }, settings });
  assert.equal(sent[0].permissionMode, "ask");
  const fresh = fixture();
  await fresh.adapter.send(chatId, { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1" }, settings });
  assert.equal(fresh.sent[0].permissionMode, "full");
});

test("a mode saved on the Chat that Milagre doesn't know falls back to the last turn's", async () => {
  const { adapter, sent } = fixture({ turnSettings: { provider: "claude", model: "opus", permissionMode: "ask" }, sessionMode: "yolo" });
  await adapter.send(chatId, { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1" }, settings: { permissionMode: "full" } });
  assert.equal(sent[0].permissionMode, "ask");
});

// createRoutines with its timer and clock in the test's hands.
function timedRoutines(t, { prepare } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "routines.json");
  prepare?.(file);
  const intervals = [];
  const routines = createRoutines({
    file,
    chats: { turnSettings: () => null },
    keepAwake: { setRoutinesActive() {} },
    emit() {},
    cachedState: () => undefined,
    openState: async () => undefined,
    timers: {
      now: () => Date.UTC(2026, 9, 16, 12),
      setInterval(fn, ms) {
        const timer = { fn, ms, cleared: false, unref() {} };
        intervals.push(timer);
        return timer;
      },
      clearInterval(timer) {
        if (timer) timer.cleared = true;
      },
      setTimeout: () => ({ unref() {} }),
      clearTimeout() {},
    },
  });
  const live = () => intervals.filter((timer) => !timer.cleared);
  return { routines, live, file };
}

test("the scheduler's timer runs only while Routines are on", async (t) => {
  const { routines, live } = timedRoutines(t);
  routines.start();
  assert.equal(live().length, 0, "off: nothing ticks");
  await routines.save(true);
  assert.equal(live().length, 1, "on: one timer ticks");
  assert.equal(live()[0].ms, 1000);
  await routines.save(false);
  assert.equal(live().length, 0, "off again: the timer stops");
  await routines.save(true);
  assert.equal(live().length, 1, "on again: it ticks again");
  routines.stop();
  assert.equal(live().length, 0);
});

test("start recovers the Runs a stop cut short even while Routines are off", async (t) => {
  const { createRoutineStore } = require("./store.cjs");
  const at = Date.UTC(2026, 9, 16, 12);
  let runId;
  let routineId;
  const { routines } = timedRoutines(t, {
    prepare(file) {
      const store = createRoutineStore({ file, now: () => at });
      store.setEnabled(true);
      const routine = store.upsertHeartbeat({
        chatId: "/project#2",
        name: "check",
        prompt: "look",
        every: "15m",
        timezone: "UTC",
        createdBy: { kind: "user" },
      });
      routineId = routine.id;
      runId = store.startRun(routine.id, at).run.id;
      store.setEnabled(false);
    },
  });
  routines.start();
  const [routine] = routines.list().routines;
  assert.equal(routine.id, routineId);
  assert.deepEqual(
    routine.runs.filter((run) => run.id === runId).map((run) => [run.status, run.error]),
    [["failed", "daemon restarted"]],
  );
});

test("the agent tools refuse a Heartbeat or a Routine from a Chat outside the Projects Milagre lists, or in a Link", async (t) => {
  const { routineTargets } = require("./runtime-adapter.cjs");
  const { createRoutineStore } = require("./store.cjs");
  const { createRoutineTools } = require("./tools.cjs");
  const { runTool } = require("../linked-tools.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-tool-targets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createRoutineStore({ file: path.join(dir, "routines.json") });
  const tools = createRoutineTools({
    store,
    scheduler: {},
    chatSettings: () => null,
    defaultTimezone: () => "UTC",
    linearWorkspaces: () => ["acme"],
    checkTarget: routineTargets({ projects: async () => [{ path: "/listed" }], openState: async () => ({ sessions: { 2: { id: 2 } } }) }),
  });
  const call = (chatId, name, args) =>
    runTool(
      tools.definitions(chatId).find((tool) => tool.name === name),
      args,
    );
  for (const chatId of ["/unlisted#2", "milagre-link:0f8e2c1a-1b2c-4d5e-8f90-123456789abc#2"]) {
    const beat = await call(chatId, "heartbeat_create", { name: "b", prompt: "p", every: "15m" });
    assert.equal(beat.isError, true, chatId);
    assert.match(beat.text, /Project/);
    const own = await call(chatId, "routine_create", { name: "r", prompt: "p", trigger: "schedule", every: "1h" });
    assert.equal(own.isError, true, chatId);
  }
  assert.deepEqual(store.list(), []);
  assert.equal((await call("/listed#2", "heartbeat_create", { name: "b", prompt: "p", every: "15m" })).isError, false);
});
