const assert = require("node:assert/strict");
const test = require("node:test");
const { SessionManager } = require("./session-manager.cjs");
const { waitUntil } = require("./test-helpers.cjs");

class FakeSession {
  constructor(provider, options) {
    Object.assign(this, { provider, options, turns: [], interrupts: 0, closed: false, running: false });
  }

  async startTurn(turn) {
    this.turns.push(turn);
    return { turnId: `t${this.turns.length}` };
  }

  emit(event) {
    this.options.emit(event);
  }

  async interrupt() {
    this.interrupts += 1;
  }

  setPermissionMode(mode) {
    this.modes = [...(this.modes ?? []), mode];
  }

  respondToPermission(requestId, decision) {
    this.answers = [...(this.answers ?? []), { requestId, decision }];
    return true;
  }

  answerQuestion(requestId, answers) {
    this.replies = [...(this.replies ?? []), { requestId, answers }];
    return true;
  }

  async close() {
    this.closed = true;
    if (this.running) {
      this.running = false;
      this.emit({ type: "turn-cancelled" });
    }
  }
}

function harness({ idleMs = 60_000 } = {}) {
  const sent = [];
  const closedChats = [];
  const created = [];
  const manager = new SessionManager({
    send: (chatId, event) => sent.push({ chatId, event }),
    onSessionClosed: (chatId) => closedChats.push(chatId),
    createSession: (provider, options) => {
      const session = new FakeSession(provider, options);
      created.push(session);
      return session;
    },
    idleMs,
    batchMs: 20,
  });
  return { manager, sent, created, closedChats };
}
const request = (chatId, extra = {}) => ({
  chatId,
  provider: "codex",
  model: "gpt-6-sol",
  cwd: "/repo",
  permissionMode: "auto",
  prompt: "hi",
  images: [],
  command: "/bin/codex",
  ...extra,
});

test("createSession receives the turn's accountId", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1", { accountId: "work" }));
  assert.equal(created[0].options.accountId, "work");
});

test("a shared Link Chat's session is told it is one, for its system prompt", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1", { sharedLink: true }));
  await manager.startTurn(request("2"));
  assert.equal(created[0].options.sharedLink, true);
  assert.equal(created[1].options.sharedLink, undefined);
});

test("account switches keep active replies, then resume their history with the new account", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1", { accountId: "personal", env: { CODEX_HOME: "/personal" } }));
  created[0].nativeId = "thread-saved";
  created[0].turnActive = true;
  const next = request("1", { accountId: "work", env: { CODEX_HOME: "/work" } });
  await manager.startTurn(next);
  assert.equal(created.length, 1);
  assert.equal(created[0].closed, false);
  assert.equal(created[0].options.env.CODEX_HOME, "/personal");
  created[0].turnActive = false;
  await manager.startTurn(next);
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
  assert.equal(created[1].options.resumeId, "thread-saved");
  assert.equal(created[1].options.env.CODEX_HOME, "/work");
});

test("creates one session per chat and reuses it", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  assert.deepEqual(await manager.startTurn(request("1", { resumeId: "thread-7" })), { turnId: "t1" });
  await manager.startTurn(request("1"));

  assert.equal(created.length, 1);
  assert.equal(created[0].turns.length, 2);
  assert.equal(created[0].options.cwd, "/repo");
  assert.equal(created[0].options.resumeId, "thread-7");
  assert.equal(created[0].options.command, "/bin/codex");
  assert.deepEqual(created[0].turns[0], {
    prompt: "hi",
    images: [],
    model: "gpt-6-sol",
    permissionMode: "auto",
    effort: undefined,
    ultracode: undefined,
    fastMode: undefined,
    replies: undefined,
  });
});

test("a turn carries the reply style to its session", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1", { replies: "concise" }));
  assert.equal(created[0].turns[0].replies, "concise");
});

test("a turn carries fast mode to its session", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1", { provider: "claude", model: "claude-opus-5-5", fastMode: true }));
  assert.equal(created[0].turns[0].fastMode, true);
});

test("keeps chats apart", async (t) => {
  const { manager, sent, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  await manager.startTurn(request("2", { provider: "claude" }));
  created[1].emit({ type: "turn-completed" });
  created[0].emit({ type: "turn-failed", message: "x" });

  assert.equal(created.length, 2);
  assert.deepEqual(sent, [
    { chatId: "2", event: { type: "turn-completed" } },
    { chatId: "1", event: { type: "turn-failed", message: "x" } },
  ]);
});

test("batches text and flushes it before the turn ends", async (t) => {
  const { manager, sent, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "text-delta", messageId: "t1", text: "Hel" });
  created[0].emit({ type: "text-delta", messageId: "t1", text: "lo" });
  assert.deepEqual(sent, []);
  created[0].emit({ type: "turn-completed" });

  assert.deepEqual(sent, [
    { chatId: "1", event: { type: "text-delta", messageId: "t1", text: "Hello" } },
    { chatId: "1", event: { type: "turn-completed" } },
  ]);
});

test("sends batched text after the batch window", async (t) => {
  const { manager, sent, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "text-delta", messageId: "t1", text: "Hi" });
  await waitUntil(() => sent.length === 1);
  assert.deepEqual(sent[0], { chatId: "1", event: { type: "text-delta", messageId: "t1", text: "Hi" } });
});

test("replaces a session after a provider switch or a crash", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  await manager.startTurn(request("1", { provider: "claude" }));
  assert.equal(created[0].closed, true);
  assert.equal(created[1].provider, "claude");

  created[1].closed = true;
  await manager.startTurn(request("1", { provider: "claude", resumeId: "session-1" }));
  assert.equal(created.length, 3);
  assert.equal(created[2].options.resumeId, "session-1");
});

test("replaces a chat's session when its working directory changes", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("2", { cwd: "/project-a" }));
  await manager.startTurn(request("2", { cwd: "/project-b" }));

  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
  assert.equal(created[0].turns.length, 1);
  assert.equal(created[1].options.cwd, "/project-b");
  assert.equal(created[1].turns.length, 1);
});

test("closes idle sessions", async (t) => {
  const { manager, created } = harness({ idleMs: 30 });
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "turn-completed" });
  await waitUntil(() => created[0].closed);
});

test("routes interrupts and closes everything on shutdown", async () => {
  const { manager, created } = harness();
  await manager.startTurn(request("1"));
  await manager.startTurn(request("2"));
  await manager.interrupt("2");
  await manager.interrupt("missing");
  assert.equal(created[1].interrupts, 1);

  await manager.closeAll();
  assert.ok(created.every((session) => session.closed));
});

test("drops events from a session that was replaced", async (t) => {
  const { manager, sent, created } = harness({ idleMs: 30 });
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  await manager.startTurn(request("1", { provider: "claude" }));
  created[0].emit({ type: "text-delta", messageId: "old", text: "late" });
  created[0].emit({ type: "turn-completed" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(sent, []);
  assert.equal(created[1].closed, false);
});

test("closing a chat delivers its final event and pending text, then goes quiet", async (t) => {
  const { manager, sent, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].running = true;
  created[0].emit({ type: "text-delta", messageId: "t1", text: "Hi" });
  await manager.closeChat("1");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(sent, [
    { chatId: "1", event: { type: "text-delta", messageId: "t1", text: "Hi" } },
    { chatId: "1", event: { type: "turn-cancelled" } },
  ]);
});

test("reports a chat whose session closed or was replaced after a crash", async (t) => {
  const { manager, created, closedChats } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  await manager.startTurn(request("2"));
  await manager.closeChat("1");
  assert.deepEqual(closedChats, ["1"]);
  created[1].closed = true;
  await manager.startTurn(request("2"));
  assert.deepEqual(closedChats, ["1", "2"]);
});

test("concurrent turns during a replacement share one new session", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].closed = true;
  await Promise.all([manager.startTurn(request("1")), manager.startTurn(request("1"))]);
  assert.equal(created.length, 2);
  assert.equal(created[1].turns.length, 2);
});

test("an idle close never reaches the session that replaced it", async (t) => {
  const { manager, created } = harness({ idleMs: 30 });
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].running = true;
  await manager.startTurn(request("1", { provider: "claude" }));
  await manager.startTurn(request("1", { provider: "claude" }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(created[0].closed, true);
  assert.equal(created[1].closed, false);
});

test("a turn the provider starts itself is not closed by the idle timer", async (t) => {
  const { manager, created } = harness({ idleMs: 30 });
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "turn-completed" });
  created[0].emit({ type: "turn-started", turnId: "t2" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(created[0].closed, false);
  created[0].emit({ type: "turn-completed" });
  await waitUntil(() => created[0].closed);
});

test("routes approval answers to the chat's session and refuses unknown decisions", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  assert.equal(manager.respondToPermission("1", "req-1", "allow-for-chat"), true);
  assert.deepEqual(created[0].answers, [{ requestId: "req-1", decision: "allow-for-chat" }]);
  assert.equal(manager.respondToPermission("9", "req-1", "allow"), false);
  assert.throws(() => manager.respondToPermission("1", "req-1", "cancelled"), /Unknown permission decision: cancelled/);
  assert.throws(() => manager.respondToPermission("1", "req-1", "yes"), /Unknown permission decision: yes/);
});

test("a mode switch reaches the chat's session", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  await manager.setPermissionMode("1", "full");
  await manager.setPermissionMode("9", "full");
  assert.deepEqual(created[0].modes, ["full"]);
  await assert.rejects(manager.setPermissionMode("1", "yolo"), /Unknown permission mode: yolo/);
});

test("an approval request is sent right after the text before it", async (t) => {
  const { manager, sent, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "text-delta", messageId: "t1", text: "Let me check" });
  created[0].emit({
    type: "permission-request",
    requestId: "r1",
    kind: "command",
    tool: "Shell",
    title: "Run this command?",
    command: "ls",
    allowForChat: true,
  });
  assert.deepEqual(
    sent.map((item) => item.event.type),
    ["text-delta", "permission-request"],
  );
});

test("command output is batched per step, in order with the reply around it", async (t) => {
  const { manager, sent, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  const step = { id: "exec-1", kind: "shell", title: "Ran `npm test`", detail: "$ npm test\n" };
  created[0].emit({ type: "text-delta", messageId: "t1", text: "Testing." });
  created[0].emit({ type: "step-started", step });
  created[0].emit({ type: "step-output", id: "exec-1", text: "ok 1\n" });
  created[0].emit({ type: "step-output", id: "exec-1", text: "ok 2\n" });
  created[0].emit({ type: "step-output", id: "exec-2", text: "other\n" });
  assert.deepEqual(
    sent.map((item) => item.event),
    [
      { type: "text-delta", messageId: "t1", text: "Testing." },
      { type: "step-started", step },
      { type: "step-output", id: "exec-1", text: "ok 1\nok 2\n" },
    ],
  );
  created[0].emit({ type: "step-completed", id: "exec-1", status: "done", detail: "$ npm test\nok 1\nok 2\n" });
  assert.deepEqual(
    sent.slice(3).map((item) => item.event),
    [
      { type: "step-output", id: "exec-2", text: "other\n" },
      { type: "step-completed", id: "exec-1", status: "done", detail: "$ npm test\nok 1\nok 2\n" },
    ],
  );
});

test("a batch of command output keeps only its end", async (t) => {
  const { manager, sent, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "step-output", id: "exec-1", text: "a".repeat(15_000) });
  created[0].emit({ type: "step-output", id: "exec-1", text: "b".repeat(15_000) });
  await waitUntil(() => sent.length === 1);
  assert.equal(sent[0].event.text, `… truncated\n${"a".repeat(5_000)}${"b".repeat(15_000)}`);
});

test("a message a closed session hands back is retried once on a fresh session", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].startTurn = async function () {
    this.closed = true;
    throw Object.assign(new Error("closed"), { sessionClosed: true });
  };
  assert.deepEqual(await manager.startTurn(request("1", { prompt: "again" })), { turnId: "t1" });
  assert.equal(created.length, 2);
  assert.equal(created[1].turns[0].prompt, "again");
});

test("a second sessionClosed failure propagates instead of retrying forever", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  const closing = async function () {
    this.closed = true;
    throw Object.assign(new Error("closed"), { sessionClosed: true });
  };
  await manager.startTurn(request("1"));
  created[0].startTurn = closing;
  const original = manager.createSession;
  manager.createSession = (provider, options) => {
    const session = original(provider, options);
    session.startTurn = closing;
    return session;
  };
  await assert.rejects(manager.startTurn(request("1")), (error) => error.sessionClosed === true);
  assert.equal(created.length, 2);
});

test("routes question answers to the chat's session and refuses malformed ones", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  assert.equal(manager.answerQuestion("1", "q-1", { color: ["Green", "a darker one"] }), true);
  assert.equal(manager.answerQuestion("1", "q-2", null), true);
  assert.deepEqual(created[0].replies, [
    { requestId: "q-1", answers: { color: ["Green", "a darker one"] } },
    { requestId: "q-2", answers: null },
  ]);
  assert.equal(manager.answerQuestion("9", "q-1", null), false);
  for (const bad of [undefined, "Green", ["Green"], { color: "Green" }, { color: [7] }, { color: ["x".repeat(10_001)] }]) {
    assert.throws(() => manager.answerQuestion("1", "q-1", bad), /Invalid answers to an agent question/);
  }
  assert.equal(created[0].replies.length, 2);
});

test("a question is sent right after the command output before it", async (t) => {
  const { manager, sent, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "step-output", id: "exec-1", text: "ok\n" });
  created[0].emit({ type: "question-request", requestId: "q-1", questions: [] });
  assert.deepEqual(
    sent.map((item) => item.event.type),
    ["step-output", "question-request"],
  );
});

test("a question is sent right after the text before it", async (t) => {
  const { manager, sent, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "text-delta", messageId: "t1", text: "One thing first" });
  created[0].emit({ type: "question-request", requestId: "q-1", questions: [] });
  created[0].emit({ type: "question-resolved", requestId: "q-1", outcome: "dismissed" });
  assert.deepEqual(
    sent.map((item) => item.event.type),
    ["text-delta", "question-request", "question-resolved"],
  );
});

test("TLDR changes resume the same chat with new instructions between turns", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  assert.equal(created[0].options.tldrEnabled, true);
  created[0].nativeId = "thread-current";
  await manager.startTurn(request("1", { tldrEnabled: false, resumeId: "thread-stale" }));
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
  assert.equal(created[1].options.resumeId, "thread-current");
  assert.equal(created[1].options.tldrEnabled, false);
  await manager.startTurn(request("1", { tldrEnabled: false }));
  assert.equal(created.length, 2);
  created[1].nativeId = "thread-current";
  await manager.startTurn(request("1", { tldrEnabled: true }));
  assert.equal(created.length, 3);
  assert.equal(created[2].options.resumeId, "thread-current");
  assert.equal(created[2].options.tldrEnabled, true);
});

test("Designs changes refresh instructions and tools between turns while preserving native history", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  let enabled = true;
  manager.linkedFor = () => ({ tools: enabled ? [{ name: "design_show" }] : [] });
  await manager.startTurn(request("1"));
  assert.equal(created[0].options.designsEnabled, true);
  created[0].nativeId = "thread-current";
  created[0].turnActive = true;
  enabled = false;
  await manager.startTurn(request("1", { designsEnabled: false }));
  assert.equal(created.length, 1, "changing the setting does not interrupt a running turn");
  created[0].turnActive = false;
  await manager.startTurn(request("1", { designsEnabled: false }));
  assert.equal(created[0].closed, true);
  assert.equal(created[1].options.designsEnabled, false);
  assert.equal(created[1].options.resumeId, "thread-current");
  assert.deepEqual(created[1].options.linked.tools, []);
  created[1].nativeId = "thread-current";
  enabled = true;
  await manager.startTurn(request("1", { designsEnabled: true }));
  assert.equal(created[2].options.designsEnabled, true);
  assert.deepEqual(created[2].options.linked.tools, [{ name: "design_show" }]);
  assert.equal(created[2].options.resumeId, "thread-current");
});

test("TLDR changes leave a running turn alone and apply once it finishes", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].turnActive = true;
  created[0].nativeId = "thread-current";
  await manager.startTurn(request("1", { tldrEnabled: false }));
  assert.equal(created.length, 1);
  assert.equal(created[0].closed, false);
  created[0].turnActive = false;
  await manager.startTurn(request("1", { tldrEnabled: false }));
  assert.equal(created.length, 2);
  assert.equal(created[1].options.tldrEnabled, false);
});

test("background children prevent idle eviction after the parent finishes", async (t) => {
  const { manager, created } = harness({ idleMs: 15 });
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "subagent-update", agent: { id: "child", status: "running" } });
  created[0].emit({ type: "turn-completed" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(created[0].closed, false);
  created[0].emit({ type: "subagent-update", agent: { id: "child", status: "completed" } });
  await waitUntil(() => created[0].closed);
});

test("a provider switch or a new folder never closes a process its background subagents run in (T3 #16000)", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  const claude = (extra = {}) => request("1", { provider: "claude", ...extra });
  await manager.startTurn(claude());
  created[0].emit({ type: "subagent-update", agent: { id: "bg", status: "running", background: true } });
  created[0].emit({ type: "subagent-update", agent: { id: "fg", status: "running" } });
  created[0].emit({ type: "turn-completed" });
  assert.equal(manager.backgroundWork("1"), 1);
  await assert.rejects(manager.startTurn(claude({ provider: "codex" })), /A background task is still running in this Chat\. Switching to Codex would stop it/);
  await assert.rejects(manager.startTurn(claude({ cwd: "/elsewhere" })), /can't move to another folder/);
  // New Links (workspace roots) or instructions wait for the next process: the turn runs on this one.
  await manager.startTurn(claude({ workspaceRoots: ["/linked"] }));
  assert.equal(created.length, 1);
  assert.equal(created[0].closed, false);
  assert.equal(created[0].turns.length, 2);
  // Once the background subagent ends, the switch goes ahead.
  created[0].emit({ type: "subagent-update", agent: { id: "bg", status: "completed", background: true } });
  assert.equal(manager.backgroundWork("1"), 0);
  await manager.startTurn(claude({ provider: "codex" }));
  assert.equal(created[0].closed, true);
  assert.equal(created[1].provider, "codex");
});

test("a background task keeps the agent process open and counts as background work until the process reports it done", async (t) => {
  const { manager, created } = harness({ idleMs: 15 });
  t.after(() => manager.closeAll());
  const claude = (extra = {}) => request("1", { provider: "claude", ...extra });
  await manager.startTurn(claude());
  created[0].emit({ type: "background-tasks", tasks: [{ id: "b1", kind: "local_bash", title: "sleep 75", startedAt: 1 }] });
  created[0].emit({ type: "turn-completed" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(created[0].closed, false);
  assert.equal(manager.backgroundWork("1"), 1);
  await assert.rejects(manager.startTurn(claude({ provider: "codex" })), /A background task is still running in this Chat/);
  created[0].emit({ type: "background-tasks", tasks: [] });
  assert.equal(manager.backgroundWork("1"), 0);
  await waitUntil(() => created[0].closed);
});

test("background subagents count only for a provider that has them", async (t) => {
  const { manager, created } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  created[0].emit({ type: "subagent-update", agent: { id: "bg", status: "running", background: true } });
  created[0].emit({ type: "background-tasks", tasks: [{ id: "b1", kind: "local_bash", title: "sleep", startedAt: 1 }] });
  assert.equal(manager.backgroundWork("1"), 0);
});

test("only a usage-limited idle process releases background work for another account or provider", async (t) => {
  for (const next of [
    { provider: "claude", accountId: "work" },
    { provider: "codex", accountId: "default" },
  ]) {
    const { manager, created } = harness();
    t.after(() => manager.closeAll());
    await manager.startTurn(request("1", { provider: "claude", accountId: "personal" }));
    created[0].emit({ type: "background-tasks", tasks: [{ id: "bg", kind: "local_bash" }] });
    assert.equal(await manager.releaseLimited("1", next.provider, next.accountId), false);
    created[0].emit({ type: "turn-failed", limit: { provider: "claude" } });
    assert.equal(await manager.releaseLimited("1", "claude", "personal"), false);
    created[0].turnActive = true;
    assert.equal(await manager.releaseLimited("1", next.provider, next.accountId), false);
    created[0].turnActive = false;
    created[0].emit({ type: "turn-started", turnId: "retry" });
    created[0].emit({ type: "turn-completed" });
    assert.equal(await manager.releaseLimited("1", next.provider, next.accountId), false);
    created[0].emit({ type: "turn-failed", limit: { provider: "claude" } });
    assert.equal(await manager.releaseLimited("1", next.provider, next.accountId), true);
    assert.equal(created[0].closed, true);
    assert.equal(manager.backgroundWork("1"), 0);
  }
});

test("Milagre's own tools ask through the chat's approval cards and read its permission mode", async () => {
  const added = [];
  const session = {
    turnActive: true,
    closed: false,
    permissions: { mode: "auto", add: (request, answer) => added.push({ request, answer }) },
    startTurn: async () => ({ turnId: "t", steered: false }),
    close: async () => {},
  };
  const manager = new SessionManager({ createSession: () => session, send: () => {} });
  assert.equal(await manager.askApproval("p#1", { requestId: "r" }), "cancelled", "a chat without a session has nobody to ask");
  assert.equal(manager.permissionMode("p#1"), "ask");
  await manager.startTurn({ chatId: "p#1", provider: "claude", cwd: "/p" });
  assert.equal(manager.permissionMode("p#1"), "auto");
  assert.equal(manager.isTurnActive("p#1"), true);
  const decision = manager.askApproval("p#1", { requestId: "r" });
  added[0].answer("deny");
  assert.equal(await decision, "deny");
});

test("an Antigravity session's models are recorded for its account once the turn has started", async () => {
  const { listAntigravityModels, forgetAntigravityModels } = require("./models.cjs");
  forgetAntigravityModels();
  const { manager, created } = harness();
  const base = { chatId: "/p#1", provider: "antigravity", cwd: "/w", command: "/agy", prompt: "hi", accountId: "acct" };
  const first = manager.startTurn(base);
  await first;
  created[0].models = [
    { value: "gemini-new-high", name: "Gemini New (High)" },
    { value: "gemini-new-low", name: "Gemini New (Low)" },
  ];
  created[0].currentModel = "gemini-new-low";
  await manager.startTurn(base);
  assert.deepEqual(
    listAntigravityModels({ accountId: "acct" }).map(({ id, efforts, defaultEffort }) => ({ id, efforts, defaultEffort })),
    [{ id: "gemini-new", efforts: ["low", "high"], defaultEffort: "low" }],
  );
  assert.notDeepEqual(
    listAntigravityModels({ accountId: "other" }).map((model) => model.id),
    ["gemini-new"],
  );
  forgetAntigravityModels();
});

test("batched provider messages keep the latest reply's notification context", async (t) => {
  const { mapCodexNotification } = require("./events.cjs");
  const { completionNotice, notificationPreview } = require("@milagre/shared/attention");
  const { manager, created, sent } = harness();
  t.after(() => manager.closeAll());
  await manager.startTurn(request("1"));
  const state = { threadId: "thread-1", turnId: "t1", hasText: false, lastItemId: null };
  for (const [itemId, delta] of [
    ["a", "I'll investigate the redirect."],
    ["b", "Login fixed."],
    ["b", "\n\n"],
    ["b", "Tests passed."],
  ]) {
    for (const event of mapCodexNotification("item/agentMessage/delta", { threadId: "thread-1", turnId: "t1", itemId, delta }, state)) created[0].emit(event);
  }
  created[0].emit({ type: "turn-completed" });
  let preview = "";
  for (const { event } of sent) if (event.type === "text-delta") preview = notificationPreview(preview, event.text, event.startsMessage);
  assert.equal(completionNotice("Fix login", { failed: false, body: preview }).body, "Login fixed. Tests passed.");
});
