const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { ESCALATION_BATCH_MS, ESCALATION_WAIT_MS } = require("@milagre/shared/subchat-escalation");
const { createRuntime } = require("./runtime.cjs");
const { PendingPermissions } = require("./agents/permissions.cjs");
const { PendingQuestions } = require("./agents/questions.cjs");
const { TICK_MS } = require("./agents/subchat-escalation.cjs");
const { turnGuards } = require("./escalation-guard.cjs");
const { runTool } = require("./linked-tools.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

// A parent Chat, and a Subchat its agent delegated to, on fake agents. The clock moves only when a test moves it.
async function family(t, { mode = "ask" } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "runtime-escalation-")));
  const project = path.join(directory, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-qb", "main", project]);
  execFileSync("git", [
    "-C",
    project,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@e.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "Initial",
  ]);
  const sessions = [];
  const notices = [];
  let tick = () => {};
  let clock = 1_000_000;
  const runtime = createRuntime({
    dataDir: path.join(directory, "data"),
    cwd: project,
    localMcpClients: { home: path.join(directory, "home"), env: {}, platform: "darwin" },
    worktreeRoot: path.join(directory, "worktrees"),
    chatsHome: path.join(directory, "chats"),
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    notifyWaiting: (notice) => notices.push(notice),
    subchatEscalation: {
      now: () => clock,
      every: (run) => {
        tick = run;
        return {};
      },
      cancel: () => {
        tick = () => {};
      },
    },
    createSession(provider, options) {
      const session = {
        provider,
        options,
        turns: [],
        turnActive: false,
        escalation: null,
        answers: [],
        permissions: new PendingPermissions(options.emit),
        questions: new PendingQuestions(options.emit),
        respondToPermission: (requestId, decision) => session.permissions.resolve(requestId, decision),
        answerQuestion: (requestId, answers) => session.questions.answer(requestId, answers),
        startTurn: async (request) => {
          session.turns.push(request);
          session.permissions.setMode(request.permissionMode);
          Object.assign(
            session,
            turnGuards(request.guard, () => {}),
          );
          session.turnActive = true;
          options.emit({ type: "turn-started", turnId: `turn-${session.turns.length}` });
          return { turnId: `turn-${session.turns.length}` };
        },
        end: () => {
          session.turnActive = false;
          session.escalation = null;
          options.emit({ type: "session-started", nativeId: "native" });
          options.emit({ type: "turn-completed" });
        },
        close: async () => session.permissions.cancelAll(),
        interrupt: async () => {
          session.turnActive = false;
          session.questions.cancelAll();
          options.emit({ type: "turn-cancelled" });
        },
      };
      sessions.push(session);
      return session;
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(project);
  const parentId = Object.values(opened.state.sessions)[0].id;
  const parentKey = `${project}#${parentId}`;
  await runtime.invoke("chat:send", [
    { projectPath: project, sessionId: parentId, body: "Redesign the panel", provider: "claude", model: "fixture", permissionMode: mode },
  ]);
  await waitUntil(() => sessions[0]?.turns.length === 1);
  const parent = sessions[0];
  const tool = (name) => parent.options.linked.tools.find((item) => item.name === name);
  await runTool(tool("delegate"), { worktree: project, chat: "new", message: "Write pill tests" });
  await waitUntil(() => sessions[1]?.turns.length === 1);
  const subchat = sessions[1];
  parent.end();
  const stateOf = () => runtime.snapshot().projects[0].state;
  const runOf = (chatId) => runtime.snapshot().runs.runs[chatId];
  await waitUntil(() => !runOf(parentKey) && stateOf().messages.some((message) => message.role === "assistant"));
  const subchatId = Object.values(stateOf().sessions).find((session) => session.parent === parentId)?.id;
  assert.ok(subchatId, "the delegation made a Subchat");
  const subchatKey = `${project}#${subchatId}`;
  const ask = (requestId = "q1") =>
    new Promise((resolve) => {
      subchat.questions.add(
        {
          requestId,
          questions: [{ id: "0", header: "", question: "Which badge?", options: [{ label: "Grey" }], multiSelect: false, allowOther: true, secret: false }],
        },
        (outcome, answers) => resolve({ outcome, answers }),
      );
    });
  const advance = async (ms) => {
    const end = clock + ms;
    while (clock < end) {
      clock = Math.min(end, clock + TICK_MS);
      tick();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const notes = (kind) => stateOf().messages.filter((message) => message.context?.kind === kind);
  return { runtime, project, parent, subchat, parentKey, subchatKey, parentId, subchatId, tool, ask, advance, notes, notices, stateOf, runOf };
}

async function woken(f) {
  void f.ask();
  await waitUntil(() => f.runOf(f.subchatKey)?.questions.length === 1);
  await f.advance(ESCALATION_WAIT_MS);
  await waitUntil(() => f.notes("subchat-escalation").length === 1);
  await f.advance(ESCALATION_BATCH_MS + TICK_MS);
  await waitUntil(() => f.parent.turns.length === 2);
}

test("a Subchat's unanswered question wakes its idle parent on the escalation guard, with the notes on both sides", async (t) => {
  const f = await family(t);
  await woken(f);
  const [waiting] = f.notes("subchat-waiting");
  assert.equal(waiting.session_id, f.subchatId);
  assert.equal(f.notes("subchat-escalation")[0].session_id, f.parentId);
  assert.deepEqual(
    f.notices.filter((notice) => notice.requestId.startsWith("reminder:")).map(({ chatId, requestId }) => ({ chatId, requestId })),
    [{ chatId: f.subchatKey, requestId: "reminder:q1" }],
  );
  const wake = f.parent.turns[1];
  assert.deepEqual(wake.guard, { level: "escalation", requests: [{ chatId: f.subchatKey, requestId: "q1" }] });
  assert.match(wake.prompt, /Which badge\?/);
  assert.equal(f.notes("subchat-wake").length, 1);
  assert.equal(f.notes("subchat-wake")[0].role, "user");
  // The same Chat's next message is the user's own, unguarded: the wake's guard is its turn's.
  f.parent.end();
  await waitUntil(() => !f.runOf(f.parentKey));
  await f.runtime.invoke("chat:send", [
    { projectPath: f.project, sessionId: f.parentId, body: "Next", provider: "claude", model: "fixture", permissionMode: "ask" },
  ]);
  await waitUntil(() => f.parent.turns.length === 3);
  assert.equal(f.parent.turns[2].guard, undefined);
});

test("a working parent is woken after its turn: nothing steers it, and no Delegation carries the wake", async (t) => {
  const f = await family(t);
  await f.runtime.invoke("chat:send", [
    { projectPath: f.project, sessionId: f.parentId, body: "Keep going", provider: "claude", model: "fixture", permissionMode: "ask" },
  ]);
  await waitUntil(() => f.parent.turns.length === 2);
  void f.ask();
  await waitUntil(() => f.runOf(f.subchatKey)?.questions.length === 1);
  await f.advance(ESCALATION_WAIT_MS);
  await waitUntil(() => f.notes("subchat-escalation").length === 1);
  await f.advance(ESCALATION_BATCH_MS * 3);
  assert.equal(f.parent.turns.length, 2, "the running turn is left alone");
  assert.equal(f.parent.turns.filter((turn) => turn.guard).length, 0);
  f.parent.end();
  await waitUntil(() => !f.runOf(f.parentKey));
  await f.advance(TICK_MS);
  await waitUntil(() => f.parent.turns.length === 3);
  assert.equal(f.parent.turns[2].guard.level, "escalation");
  assert.equal(
    (await f.runtime.invoke("linked:snapshot", [])).delegations.some((item) => item.to_chat === f.parentKey),
    false,
  );
});

test("every Milagre tool asks the turn's guard: only chat_respond on the woken request gets through", async (t) => {
  const f = await family(t);
  await woken(f);
  assert.match((await runTool(f.tool("phase_set"), { phase: "build" })).text, /only tells the human/);
  const read = await runTool(f.tool("chat_read"), { projectPath: f.project, chatId: f.subchatKey, limit: 5 });
  assert.equal(read.isError, false);
  const other = { projectPath: f.project, chatId: f.subchatKey, requestId: "another", answers: { 0: ["Grey"] }, suggest: true };
  assert.match((await runTool(f.tool("chat_respond"), other)).text, /only tells the human/);
  const respond = { projectPath: f.project, chatId: f.subchatKey, requestId: "q1", answers: { 0: ["Grey"] }, suggest: true };
  const suggested = await runTool(f.tool("chat_respond"), respond);
  assert.equal(suggested.isError, false, suggested.text);
  assert.match(suggested.text, /Suggested\. The human decides\./);
  assert.equal(f.notes("subchat-suggestion").length, 1);
});

test("Send answer on a card answers the Subchat and leaves the outcome the screens show", async (t) => {
  const f = await family(t);
  const answered = f.ask();
  await waitUntil(() => f.runOf(f.subchatKey)?.questions.length === 1);
  await runTool(f.tool("chat_respond"), { projectPath: f.project, chatId: f.subchatKey, requestId: "q1", answers: { 0: ["Grey"] }, suggest: true });
  const { id, answers, requestId } = f.notes("subchat-suggestion")[0].context;
  assert.equal(
    await f.runtime.invoke("agent:answer-question", [{ chatId: f.subchatKey, requestId, answers, summary: "Which badge?: Grey", suggestionId: id }]),
    true,
  );
  assert.deepEqual(await answered, { outcome: "answered", answers: { 0: ["Grey"] } });
  await waitUntil(() => f.notes("subchat-suggestion-outcome").length === 1);
  assert.match(f.notes("subchat-suggestion-outcome")[0].body, /^Sent "Grey" to /);
  assert.equal(f.notes("subchat-suggestion-outcome")[0].context.outcome, "sent");
  assert.equal(f.stateOf().sessions[f.parentId].openSuggestions, undefined);
});

test("Dismiss takes the card and leaves the question open", async (t) => {
  const f = await family(t);
  void f.ask();
  await waitUntil(() => f.runOf(f.subchatKey)?.questions.length === 1);
  await runTool(f.tool("chat_respond"), { projectPath: f.project, chatId: f.subchatKey, requestId: "q1", answers: { 0: ["Grey"] }, suggest: true });
  const { id } = f.notes("subchat-suggestion")[0].context;
  assert.equal(await f.runtime.invoke("agent:dismiss-suggestion", [{ chatId: f.parentKey, id }]), true);
  await waitUntil(() => f.notes("subchat-suggestion-outcome").length === 1);
  assert.equal(f.notes("subchat-suggestion-outcome")[0].context.outcome, "dismissed");
  assert.equal(f.runOf(f.subchatKey)?.questions.length, 1);
});

test("a parent in Full answers alone: the Subchat goes on, and both transcripts say who answered", async (t) => {
  const f = await family(t, { mode: "full" });
  const answered = f.ask();
  await waitUntil(() => f.runOf(f.subchatKey)?.questions.length === 1);
  const result = await runTool(f.tool("chat_respond"), { projectPath: f.project, chatId: f.subchatKey, requestId: "q1", answers: { 0: ["Grey"] } });
  assert.equal(result.isError, false, result.text);
  assert.equal((await answered).outcome, "answered");
  await waitUntil(() => f.notes("subchat-answered-by").length === 1 && f.notes("subchat-suggestion-outcome").length === 1);
  const [by] = f.notes("subchat-answered-by");
  assert.equal(by.session_id, f.subchatId);
  assert.equal(by.context.label, "Grey");
  assert.equal(f.notes("subchat-suggestion-outcome")[0].session_id, f.parentId);
  assert.match(f.notes("subchat-suggestion-outcome")[0].body, /^Answered "Grey" in /);
  // Nobody typed it, so the Subchat shows no message from the user.
  assert.equal(f.stateOf().messages.filter((message) => message.session_id === f.subchatId && message.role === "user" && message.body === "Grey").length, 0);
});

test("a question nobody answers for the user: a parent not in Full is told to suggest", async (t) => {
  const f = await family(t);
  void f.ask();
  await waitUntil(() => f.runOf(f.subchatKey)?.questions.length === 1);
  const refused = await runTool(f.tool("chat_respond"), { projectPath: f.project, chatId: f.subchatKey, requestId: "q1", answers: { 0: ["Grey"] } });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Use suggest: true/);
});

test("a client can't pass as an agent: the sender is never read from a request", async (t) => {
  const f = await family(t);
  const answered = f.ask();
  await waitUntil(() => f.runOf(f.subchatKey)?.questions.length === 1);
  await f.runtime.invoke("agent:answer-question", [
    { chatId: f.subchatKey, requestId: "q1", answers: { 0: ["Grey"] }, summary: "Grey", sender: { agent: f.parentKey } },
  ]);
  await answered;
  assert.equal(f.notes("subchat-answered-by").length, 0);
});
