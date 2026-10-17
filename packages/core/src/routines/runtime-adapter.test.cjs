const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRoutines, routineChats, routineReply } = require("./runtime-adapter.cjs");

const chatId = "/project#2";
const state = {
  sessions: { 2: { id: 2, worktree_id: 1, provider: "codex" }, 3: { id: 3, worktree_id: 1, archived: true } },
  messages: [
    { id: 1, session_id: 2, role: "user", body: "Watch CI", context: null, model: "gpt-x" },
    { id: 2, session_id: 2, role: "assistant", body: "(pass) old beat", context: null },
    { id: 3, session_id: 2, role: "user", body: "Check CI", context: { kind: "routine-run", runId: "run-1" }, model: "gpt-x" },
    { id: 4, session_id: 2, role: "assistant", body: "Note", context: { kind: "git-action" } },
    { id: 5, session_id: 2, role: "assistant", body: "  (pass) CI green  ", context: null },
  ],
};

function fixture({ turnSettings = null, runs = {}, busy = false, open = true } = {}) {
  const sent = [];
  const patched = [];
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
  const store = { get: (id) => (id === "r1" ? { id, provider: "claude", model: "cm", permissionMode: "full" } : null) };
  const adapter = routineChats({
    chats,
    store,
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
    store: { get: () => null },
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

test("after a restart a beat runs on the Chat's own provider and last model, with the routine's stored permission mode", async () => {
  const { adapter, sent } = fixture();
  const context = { kind: "routine-run", routineId: "r1", runId: "run-2" };
  const { started } = await adapter.send(chatId, { body: "Check CI", prompt: "Check CI + hint", context });
  assert.deepEqual(await started, { turnId: "t" });
  assert.equal(sent[0].provider, "codex");
  assert.equal(sent[0].model, "gpt-x");
  assert.equal(sent[0].permissionMode, "full");
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
    state.messages.filter(match).map((message) => message.id),
    [3],
  );
});

test("send says whether the Chat was unread, and patchRunContext hands a session patch on", async () => {
  const { adapter, patched } = fixture();
  state.sessions[2].unread = true;
  try {
    const result = await adapter.send(chatId, { body: "Check CI", prompt: "Check CI", context: { kind: "routine-run", routineId: "r1", runId: "run-2" } });
    assert.equal(result.unread, true);
  } finally {
    delete state.sessions[2].unread;
  }
  assert.equal(
    (await adapter.send(chatId, { body: "Check CI", prompt: "Check CI", context: { kind: "routine-run", routineId: "r1", runId: "run-3" } })).unread,
    false,
  );
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
function newChatFixture({ removable = true, failChat = false, createDelayMs = 0, timeoutMs, hooks, send } = {}) {
  const calls = { created: [], removed: [], archived: [], emptyChats: [] };
  const projectState = {
    worktrees: { 1: { id: 1, path: "/project" }, 7: { id: 7, path: "/worktrees/seven", base: "main" } },
    sessions: { 4: { id: 4, worktree_id: 7 } },
    messages: [],
  };
  const chats = {
    runs: {},
    isBusy: () => false,
    turnSettings: () => null,
    ...(send ? { send } : {}),
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
    store: { get: () => null },
    cachedState: (scope) => (scope === "/project" ? projectState : undefined),
    openState: async () => projectState,
    isClosing: () => false,
    worktrees,
    archiveChat: async (chatId) => calls.archived.push(chatId),
    now: () => Date.UTC(2026, 9, 16, 11, 5),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(hooks ? { hooks } : {}),
  });
  return { adapter, calls };
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

test("a webhook Run whose delivery is gone fails before making anything", async () => {
  const { adapter, calls } = newChatFixture();
  await assert.rejects(
    adapter.startChat({
      routine: triage("worktree", { kind: "webhook", hookId: "h", signed: false }),
      run: { id: "r", event: { kind: "webhook", key: "k", deliveryId: "d" } },
    }),
    /no longer on this Mac/,
  );
  assert.deepEqual(calls.created, []);
});

test("a webhook Run words its first message from the delivery and deletes the delivery once that message is sent", async () => {
  const deliveries = new Map([
    ["d1", { id: "d1", hookId: "h", receivedAt: 1, headers: { "x-env": "prod" }, query: {}, body: new TextEncoder().encode('{"a":1}') }],
  ]);
  const store = { getDelivery: (id) => deliveries.get(id) ?? null, takeDelivery: (id) => deliveries.delete(id) };
  const { adapter } = newChatFixture({ hooks: () => ({ store, relayUrl: "wss://relay" }), send: async () => ({ started: true }) });
  const routine = { ...triage("worktree", { kind: "webhook", hookId: "h", signed: false }), prompt: "Body {{body}} env {{headers.x-env}}" };
  const chat = await adapter.startChat({ routine, run: { id: "run-1", event: { kind: "webhook", key: "webhook:d1", deliveryId: "d1" } } });
  assert.match(chat.body, /<untrusted-data source="webhook body">\n\{"a":1\}\n<\/untrusted-data>/);
  assert.match(chat.body, /prod/);
  assert.ok(deliveries.has("d1"), "kept until the message is sent");
  await adapter.send(chat.chatId, { body: chat.body, prompt: chat.prompt, context: chat.context });
  assert.equal(deliveries.has("d1"), false);
});

test("a Linear Run makes the issue's Worktree and names the Chat after the issue", async () => {
  const { adapter, calls } = newChatFixture();
  const issue = { id: "i", key: "MIL-1", title: "Paste images", description: "d", url: "u", labels: [], state: "Todo", team: "MIL", workspace: "w1" };
  const routine = { ...triage("worktree", { kind: "linear", workspace: "w1", event: "assigned" }), prompt: "Work on {{issue.key}}: {{issue.title}}" };
  const chat = await adapter.startChat({ routine, run: { id: "run-9", event: { kind: "linear", key: "linear:i:h", change: "assigned", issue } } });
  assert.deepEqual(calls.created, [{ projectPath: "/project", baseBranch: "main", prompt: "", issueKey: "MIL-1", issueWorkspace: "w1" }]);
  assert.equal(calls.emptyChats[0].options.title, "MIL-1 Paste images");
  assert.equal(chat.body, "Work on MIL-1: Paste images");
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
  routines.create({
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
  routines.create({
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

test("a webhook Run whose first message fails to send deletes its delivery, as a failed start does", async () => {
  const deliveries = new Map([["d1", { id: "d1", hookId: "h", receivedAt: 1, headers: {}, query: {}, body: new TextEncoder().encode("{}") }]]);
  const store = { getDelivery: (id) => deliveries.get(id) ?? null, takeDelivery: (id) => deliveries.delete(id) };
  const { adapter } = newChatFixture({
    hooks: () => ({ store, relayUrl: "wss://relay" }),
    send: async () => {
      throw new Error("agent CLI missing");
    },
  });
  const routine = { ...triage("worktree", { kind: "webhook", hookId: "h", signed: false }), prompt: "{{body}}" };
  const chat = await adapter.startChat({ routine, run: { id: "run-1", event: { kind: "webhook", key: "webhook:d1", deliveryId: "d1" } } });
  await assert.rejects(adapter.send(chat.chatId, { body: chat.body, prompt: chat.prompt, context: chat.context }), /agent CLI missing/);
  assert.equal(deliveries.has("d1"), false);
});

test("rotating writes the new secret first and puts the old one back when the Routine can't be updated", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const { createWebhooks } = require("./runtime-adapter.cjs");
  const { createRoutineStore } = require("./store.cjs");
  const { createHookStore } = require("./hook-store.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const routines = createRoutineStore({ file: path.join(dir, "routines.json") });
  routines.setEnabled(true);
  const secrets = createHookStore({ file: path.join(dir, "routine-hooks.json") });
  let failUpdate = false;
  const store = {
    ...routines,
    update: (...args) => {
      if (failUpdate) throw new Error("disk full");
      return routines.update(...args);
    },
  };
  const webhooks = createWebhooks({
    store,
    scheduler: { enqueueEvents: () => [] },
    hooks: () => ({ store: secrets, relayUrl: "wss://relay" }),
    changed: () => {},
  });
  const routine = webhooks.create({
    name: "Sentry",
    prompt: "{{body}}",
    trigger: { kind: "webhook" },
    target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
    signingSecret: "shh",
  });
  const before = webhooks.hook(routine.id).url;
  const ownerBefore = webhooks.owners([routine.trigger.hookId])[routine.trigger.hookId];
  failUpdate = true;
  assert.throws(() => webhooks.rotate(routine.id), /disk full/);
  assert.equal(webhooks.hook(routine.id).url, before, "the old URL still works");
  assert.equal(secrets.secretFor(routine.id).previous, undefined, "nothing half-written is left");
  assert.equal(webhooks.owners([routine.trigger.hookId])[routine.trigger.hookId], ownerBefore);
  // A crash between the two writes: the new secret is saved, the Routine still has the old hook id.
  const saved = secrets.secretFor(routine.id);
  secrets.setSecret(routine.id, { secret: "n".repeat(43), ownerKey: "o".repeat(43), signingSecret: saved.signingSecret, previous: saved });
  assert.equal(webhooks.hook(routine.id).url, before, "the entry that matches the Routine's hook id wins");
  assert.equal(webhooks.owners([routine.trigger.hookId])[routine.trigger.hookId], ownerBefore);
  assert.equal(crypto.createHash("sha256").update(before.split("/hook/")[1]).digest("hex"), routine.trigger.hookId);
  failUpdate = false;
  const { url } = webhooks.rotate(routine.id);
  assert.notEqual(url, before);
  assert.equal(secrets.secretFor(routine.id).previous, undefined);
  assert.equal(webhooks.hook(routine.id).signed, true);
});
