import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, ChatStep, CoordinatorState, PermissionRequest, QuestionRequest } from "./model.ts";
import {
  answeredQuestions,
  applyAgentEvent,
  applyRunEvent,
  capOutput,
  chatInProject,
  chatKey,
  computerOfKey,
  projectOfKey,
  recordAnswers,
  sessionIdFromKey,
  splitRunForSteer,
  startRun,
  subagentActive,
} from "./agent-runs.mjs";
import type { AgentRuns } from "./agent-runs.mjs";
import { archiveFinishedSubagents } from "./project-edits.mjs";

const PROJECT = "/work/app";
const key = (sessionId: number) => chatKey(PROJECT, sessionId);

const base = (): CoordinatorState => ({
  next_id: 10,
  projects: {},
  worktrees: {},
  sessions: {
    "1": { id: 1, worktree_id: 1, agent_name: "main", status: "Created", provider: "codex" },
    "2": { id: 2, worktree_id: 1, agent_name: "main", status: "Created", provider: "claude", native_session_id: "s-old" },
  },
  connections: {},
  events: [],
  messages: [],
  approvals: [],
  tasks: {},
  artifacts: {},
  outputs: [],
  conflicts: [],
});

test("chat keys name a project and a session, even when the path contains #", () => {
  assert.equal(chatKey("/work/app", 2), "/work/app#2");
  assert.equal(sessionIdFromKey(chatKey("/work/app", 2)), 2);
  assert.equal(chatKey("/tmp/a#b", 12), "/tmp/a#b#12");
  assert.equal(sessionIdFromKey(chatKey("/tmp/a#b", 12)), 12);
  assert.ok(Number.isNaN(sessionIdFromKey("/work/app")));
  assert.ok(Number.isNaN(sessionIdFromKey("/work/app#")));

  assert.equal(chatInProject("/tmp/a#b", chatKey("/tmp/a#b", 12)), true);
  assert.equal(chatInProject("/tmp/a", chatKey("/tmp/a#b", 12)), false);
  assert.equal(chatInProject("/tmp/a#b", chatKey("/tmp/a", 12)), false);
});

test("a turn keeps its start time through events and steering; the next turn starts fresh", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  let state = base();
  let runs = startRun({}, key(1), "gpt-6-sol");
  assert.equal(runs[key(1)].startedAt, 100_000);
  t.mock.timers.tick(20_000);
  for (const event of [
    { type: "turn-started" },
    { type: "text-delta", messageId: "m", text: "Working" },
    { type: "subagents-waiting", waiting: true },
    { type: "message-sent", model: "gpt-6-sol" },
    { type: "answers-sent" },
  ] as AgentEvent[]) {
    ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), event));
    assert.equal(runs[key(1)].startedAt, 100_000);
  }
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "turn-completed" }));
  assert.equal(runs[key(1)], undefined);
  ({ runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "turn-started" }));
  assert.equal(runs[key(1)].startedAt, 120_000);
});

test("saves and forgets the agent's native session id", () => {
  const started = applyAgentEvent(base(), {}, PROJECT, key(1), { type: "session-started", nativeId: "thread-1" });
  assert.equal(started.changed, true);
  assert.equal(started.state.sessions["1"].native_session_id, "thread-1");
  assert.equal(applyAgentEvent(started.state, {}, PROJECT, key(1), { type: "session-started", nativeId: "thread-1" }).changed, false);

  const reset = applyAgentEvent(base(), {}, PROJECT, key(2), { type: "session-reset" });
  assert.equal(reset.changed, true);
  assert.equal("native_session_id" in reset.state.sessions["2"], false);
});

test("streams text per chat and saves each finished reply once", () => {
  let state = base();
  let runs = startRun(startRun({}, key(1), "gpt-6-sol"), key(2), "claude-opus-5-5");
  for (const [sessionId, text] of [
    [1, "Hel"],
    [2, "Hi"],
    [1, "lo"],
    [2, " there"],
  ] as const) {
    ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(sessionId), { type: "text-delta", messageId: "t", text }));
  }
  assert.equal(runs[key(1)].text, "Hello");
  assert.equal(runs[key(2)].text, "Hi there");

  const first = applyAgentEvent(state, runs, PROJECT, key(2), { type: "turn-completed" });
  const second = applyAgentEvent(first.state, first.runs, PROJECT, key(1), { type: "turn-completed" });
  assert.equal(second.changed, true);
  assert.deepEqual(second.runs, {});
  assert.deepEqual(
    second.state.messages.map(({ id, session_id, body, role, model, outcome }) => ({ id, session_id, body, role, model, outcome })),
    [
      { id: 10, session_id: 2, body: "Hi there", role: "assistant", model: "claude-opus-5-5", outcome: "completed" },
      { id: 11, session_id: 1, body: "Hello", role: "assistant", model: "gpt-6-sol", outcome: "completed" },
    ],
  );
  assert.equal(second.state.next_id, 12);
});

test("Milagre's own failure messages carry no \"Agent error:\" prefix, the agent's raw errors do", () => {
  const run = (text: string) => ({ [key(1)]: { text, model: "gpt-6-sol", approvals: [], steps: [], questions: [], answered: {} } });
  const own = applyAgentEvent(base(), run(""), PROJECT, key(1), {
    type: "turn-failed",
    message: "Codex isn't logged in. Run `codex login` in a terminal, then send your message again.",
    notice: true,
    login: true,
  });
  assert.equal(own.state.messages[0].body, "Codex isn't logged in. Run `codex login` in a terminal, then send your message again.");
  const partial = applyAgentEvent(base(), run("Half"), PROJECT, key(1), {
    type: "turn-failed",
    message: "Codex stopped unexpectedly. Send your message again to continue this chat.",
    notice: true,
  });
  assert.equal(partial.state.messages[0].body, "Half\n\nCodex stopped unexpectedly. Send your message again to continue this chat.");
  const raw = applyAgentEvent(base(), run(""), PROJECT, key(1), { type: "turn-failed", message: "The model gpt-x is not supported." });
  assert.equal(raw.state.messages[0].body, "Agent error: The model gpt-x is not supported.");
});

test("a turn the usage limit stopped saves the limit on its reply, other failures save no context", () => {
  const run = { [key(1)]: { text: "", model: "claude-opus-5-5", approvals: [], steps: [], questions: [], answered: {} } };
  const limit = { provider: "claude" as const, accountId: "work", window: "five_hour", resetsAt: "2026-10-13T16:10:00.000Z" };
  const limited = applyAgentEvent(base(), run, PROJECT, key(1), { type: "turn-failed", message: "You've hit your session limit", notice: true, limit });
  assert.equal(limited.state.messages[0].body, "You've hit your session limit");
  assert.deepEqual(limited.state.messages[0].context, { kind: "limit", ...limit });
  const other = applyAgentEvent(base(), run, PROJECT, key(1), { type: "turn-failed", message: "boom" });
  assert.equal(other.state.messages[0].context, null);
});

test("keeps partial text when a turn fails or is cancelled", () => {
  const runs = { [key(1)]: { text: "Half an answer", model: "gpt-6-sol", approvals: [], steps: [], questions: [], answered: {} } };
  const failed = applyAgentEvent(base(), runs, PROJECT, key(1), { type: "turn-failed", message: "Codex stopped: boom" });
  assert.equal(failed.state.messages[0].body, "Half an answer\n\nAgent error: Codex stopped: boom");
  assert.equal(failed.state.messages[0].outcome, "failed");

  const cancelled = applyAgentEvent(
    base(),
    { [key(1)]: { text: "", model: "gpt-6-sol", approvals: [], steps: [], questions: [], answered: {} } },
    PROJECT,
    key(1),
    { type: "turn-cancelled" },
  );
  assert.equal(cancelled.state.messages[0].body, "");
  assert.equal(cancelled.state.messages[0].outcome, "cancelled");
});

test("stopping keeps the agent's language and records even an empty or quit-cancelled reply", () => {
  for (const text of ["", "  \n  ", "  Começando a verificação.\n", "検証を開始します。", "What should I work on instead?"]) {
    for (const quit of [false, true]) {
      const runs = startRun({}, key(1), "gpt-6-sol");
      runs[key(1)].text = text;
      const stopped = applyAgentEvent(base(), runs, PROJECT, key(1), { type: "turn-cancelled", ...(quit ? { quit } : {}) });
      const message = stopped.state.messages[0];
      assert.equal(message.body, text.trim());
      assert.equal(message.outcome, "cancelled");
      assert.equal(message.id, 10);
      assert.equal(stopped.state.next_id, 11);
      assert.equal(stopped.changed, true);
      assert.equal(stopped.runs[key(1)], undefined);
    }
  }
});

test("ignores events for chats with nothing running", () => {
  const state = base();
  assert.deepEqual(applyAgentEvent(state, {}, PROJECT, key(1), { type: "text-delta", messageId: "t", text: "x" }), { state, runs: {}, changed: false });
  assert.deepEqual(applyAgentEvent(state, {}, PROJECT, key(1), { type: "turn-completed" }), { state, runs: {}, changed: false });
});

test("a key from another project path never touches this state", () => {
  const state = base();
  // "/work/app#x" + "#2" starts with "/work/app#" but belongs to the project at "/work/app#x".
  for (const other of ["/work/other", "/work", "/work/app#x", "/work/app/sub"]) {
    const runs = { [chatKey(other, 2)]: { text: "Not yours", model: "claude-opus-5-5", approvals: [], steps: [], questions: [], answered: {} } };
    for (const event of [
      { type: "session-started", nativeId: "foreign" },
      { type: "session-reset" },
      { type: "text-delta", messageId: "t", text: "x" },
      { type: "turn-completed" },
    ] as const) {
      assert.deepEqual(applyAgentEvent(state, runs, PROJECT, chatKey(other, 2), event), { state, runs, changed: false });
    }
  }
});

test("an unknown session id is a no-op", () => {
  const state = base();
  const runs = { [key(99)]: { text: "Orphan", model: "gpt-6-sol", approvals: [], steps: [], questions: [], answered: {} } };
  for (const chatId of [key(99), `${PROJECT}#`, `${PROJECT}#abc`]) {
    assert.deepEqual(applyAgentEvent(state, runs, PROJECT, chatId, { type: "session-started", nativeId: "x" }), { state, runs, changed: false });
    assert.deepEqual(applyAgentEvent(state, runs, PROJECT, chatId, { type: "turn-completed" }), { state, runs, changed: false });
  }
});

test("an unknown event type changes nothing", () => {
  const state = base();
  const runs = { [key(1)]: { text: "Partial", model: "gpt-6-sol", approvals: [], steps: [], questions: [], answered: {} } };
  // Later steps add event types (tool steps, approvals); only the three turn endings end a run.
  const event = { type: "tool-started", toolId: "t-1" } as unknown as AgentEvent;
  assert.deepEqual(applyAgentEvent(state, runs, PROJECT, key(1), event), { state, runs, changed: false });
});

const approval = (requestId: string): PermissionRequest => ({
  requestId,
  kind: "command",
  tool: "Shell",
  title: "Run this command?",
  command: "ls",
  allowForChat: true,
});

test("message-sent keeps the permission mode the turn starts in", () => {
  const runs = applyRunEvent({}, key(1), { type: "message-sent", model: "claude-opus-5-5", permissionMode: "full" });
  assert.equal(runs[key(1)].permissionMode, "full");
  assert.equal(applyRunEvent({}, key(1), { type: "message-sent", model: "claude-opus-5-5" })[key(1)].permissionMode, undefined);
});

test("turn-started opens a run for a turn this window didn't start", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const state = { ...base(), messages: [{ id: 5, session_id: 2, body: "One more thing", context: null, role: "user" as const, model: "claude-opus-5-5" }] };
  const opened = applyAgentEvent(state, {}, PROJECT, key(2), { type: "turn-started", turnId: "t-2" });
  assert.deepEqual(opened.runs[key(2)], {
    text: "",
    model: "claude-opus-5-5",
    startedAt: 100_000,
    approvals: [],
    steps: [],
    questions: [],
    answered: {},
    turnId: "t-2",
  });
  assert.equal(opened.changed, false);

  const running = startRun({}, key(2), "claude-sonnet-5-5");
  const kept = applyAgentEvent(state, running, PROJECT, key(2), { type: "turn-started", turnId: "t-2" });
  assert.equal(kept.runs[key(2)].model, running[key(2)].model);
  assert.equal(kept.runs[key(2)].turnId, "t-2");
  assert.equal(applyAgentEvent(state, kept.runs, PROJECT, key(2), { type: "turn-started", turnId: "t-2" }).runs, kept.runs);
});

test("approval requests wait on the run, oldest first, until they're resolved", () => {
  let runs = startRun({}, key(1), "gpt-6-sol");
  const state = base();
  for (const requestId of ["a", "b"]) runs = applyAgentEvent(state, runs, PROJECT, key(1), { type: "permission-request", ...approval(requestId) }).runs;
  assert.deepEqual(
    runs[key(1)].approvals.map((item) => item.requestId),
    ["a", "b"],
  );
  assert.deepEqual(runs[key(1)].approvals[0], approval("a"));

  runs = applyAgentEvent(state, runs, PROJECT, key(1), { type: "permission-request", ...approval("a"), title: "Again?" }).runs;
  assert.deepEqual(
    runs[key(1)].approvals.map((item) => item.requestId),
    ["b", "a"],
  );

  runs = applyAgentEvent(state, runs, PROJECT, key(1), { type: "permission-resolved", requestId: "b", decision: "deny" }).runs;
  assert.deepEqual(
    runs[key(1)].approvals.map((item) => item.requestId),
    ["a"],
  );
  runs = applyAgentEvent(state, runs, PROJECT, key(1), { type: "permission-resolved", requestId: "missing", decision: "cancelled" }).runs;
  assert.equal(runs[key(1)].approvals.length, 1);

  const ended = applyAgentEvent(state, runs, PROJECT, key(1), { type: "turn-cancelled" });
  assert.equal(ended.runs[key(1)], undefined);
  assert.equal(applyAgentEvent(state, {}, PROJECT, key(1), { type: "permission-request", ...approval("c") }).runs[key(1)], undefined);
});

function viewedImage(id: string): Extract<AgentEvent, { type: "step-started" }> {
  return {
    type: "step-started",
    step: { id, kind: "image", title: "Viewed an image", file: `/tmp/${id}.png`, imageOrigin: "viewed", sourceFile: "/work/original.png" },
  };
}

test("viewed image admission keeps 16 distinct steps, replay positions and ordinary tool rows", () => {
  let runs = startRun({}, key(1), "claude");
  for (let i = 0; i < 20; i++) {
    runs = applyRunEvent(runs, key(1), { type: "step-started", step: { id: `read-${i}`, kind: "read", title: "Read image" } });
    runs = applyRunEvent(runs, key(1), { type: "step-completed", id: `read-${i}`, status: "done" });
    runs = applyRunEvent(runs, key(1), viewedImage(`image-${i}`));
    runs = applyRunEvent(runs, key(1), { type: "step-completed", id: `image-${i}`, status: "done" });
    runs = applyRunEvent(runs, key(1), { type: "step-started", step: { id: `generated-${i}`, kind: "image", title: "Generated an image" } });
  }
  const steps = runs[key(1)].steps;
  assert.equal(steps.filter((step) => step.imageOrigin === "viewed").length, 16);
  assert.equal(steps.filter((step) => step.kind === "read").length, 20);
  assert.equal(steps.filter((step) => step.kind === "image" && !step.imageOrigin).length, 20);
  assert.equal(steps.find((step) => step.id === "image-0")?.sourceFile, "/work/original.png");
  assert.equal(steps.find((step) => step.id === "image-0")?.status, "done");
  for (let i = 0; i < 20; i++) {
    runs = applyRunEvent(runs, key(1), viewedImage(`image-${i}`));
    runs = applyRunEvent(runs, key(1), { type: "step-completed", id: `image-${i}`, status: "done" });
  }
  assert.deepEqual(
    runs[key(1)].steps.map((step) => step.id),
    steps.map((step) => step.id),
  );
  assert.equal(applyRunEvent(runs, key(1), viewedImage("overflow")), runs);
  assert.equal(applyRunEvent(runs, key(1), { type: "step-completed", id: "overflow", status: "done" }), runs);
});

test("untagged step replays retain their existing move-to-end ordering", () => {
  let runs = startRun({}, key(1), "claude");
  const read = { id: "read", kind: "read" as const, title: "Read a file" };
  const generated = { id: "generated", kind: "image" as const, title: "Generated an image" };
  for (const step of [read, generated, read]) runs = applyRunEvent(runs, key(1), { type: "step-started", step });
  assert.deepEqual(
    runs[key(1)].steps.map((step) => step.id),
    ["generated", "read"],
  );
  runs = applyRunEvent(runs, key(1), { type: "step-started", step: generated });
  assert.deepEqual(
    runs[key(1)].steps.map((step) => step.id),
    ["read", "generated"],
  );
});

test("steering saves completed viewed snapshots and gives each reply its own allowance", () => {
  let state = base();
  let runs = startRun({}, key(1), "claude");
  const emit = (event: AgentEvent) => {
    const result = applyAgentEvent(state, runs, PROJECT, key(1), event);
    state = result.state;
    runs = result.runs;
  };
  for (let reply = 0; reply < 2; reply++) {
    for (let i = 0; i < 20; i++) {
      const id = `image-${reply}-${i}`;
      emit(viewedImage(id));
      emit({ type: "step-completed", id, status: "done" });
    }
    if (reply === 0) emit({ type: "message-sent", model: "claude" });
  }
  emit({ type: "turn-completed" });
  assert.equal(state.messages.length, 2);
  for (const [reply, message] of state.messages.entries()) {
    assert.equal(message.steps?.length, 16);
    assert.equal(message.steps?.[0].id, `image-${reply}-0`);
    assert.equal(message.steps?.[0].imageOrigin, "viewed");
    assert.equal(message.steps?.[0].sourceFile, "/work/original.png");
  }
});

test("viewed snapshots still running across a steer occupy slots in the new reply", () => {
  let runs = startRun({}, key(1), "claude");
  runs = applyRunEvent(runs, key(1), { type: "text-delta", messageId: "m", text: "Before steering" });
  runs = applyRunEvent(runs, key(1), viewedImage("running"));
  runs = applyRunEvent(runs, key(1), { type: "message-sent", model: "claude" });
  for (let i = 0; i < 20; i++) runs = applyRunEvent(runs, key(1), viewedImage(`next-${i}`));
  assert.equal(runs[key(1)].steps.length, 16);
  assert.equal(runs[key(1)].steps[0].id, "running");
  assert.equal(runs[key(1)].steps.at(-1)?.id, "next-14");
});

test("a steer saves the reply so far and keeps the run going", () => {
  const state = base();
  const runs = { [key(1)]: { text: "  Half an answer \n", model: "gpt-6-sol", approvals: [approval("a")], steps: [], questions: [], answered: {} } };
  const split = splitRunForSteer(state, runs, PROJECT, key(1));
  assert.equal(split.changed, true);
  assert.deepEqual(split.state.messages.at(-1), {
    id: state.next_id,
    session_id: 1,
    body: "Half an answer",
    context: null,
    role: "assistant",
    model: "gpt-6-sol",
  });
  assert.equal(split.state.next_id, state.next_id + 1);
  assert.deepEqual(split.runs[key(1)], { text: "", model: "gpt-6-sol", approvals: [approval("a")], steps: [], questions: [], answered: {}, split: true });

  const cases: Array<[AgentRuns, string]> = [
    [{ [key(1)]: { text: "  ", model: "gpt-6-sol", approvals: [], steps: [], questions: [], answered: {} } }, key(1)],
    [{}, key(1)],
    [runs, chatKey("/work/other", 1)],
    [runs, key(99)],
  ];
  for (const [testRuns, chatId] of cases) {
    const unchanged = splitRunForSteer(state, testRuns, PROJECT, chatId);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.state, state);
    assert.equal(unchanged.runs, testRuns);
  }
});

test("a turn that completes with no text after a steer split saves no reply", () => {
  const state = base();
  const runs = { [key(1)]: { text: "Half", model: "gpt-6-sol", approvals: [], steps: [], questions: [], answered: {} } };
  const split = splitRunForSteer(state, runs, PROJECT, key(1));
  assert.equal(split.runs[key(1)].split, true);
  const done = applyAgentEvent(split.state, split.runs, PROJECT, key(1), { type: "turn-completed" });
  assert.equal(done.runs[key(1)], undefined);
  assert.equal(done.state, split.state);
  assert.equal(done.changed, false);
  const cancelled = applyAgentEvent(split.state, split.runs, PROJECT, key(1), { type: "turn-cancelled" });
  assert.equal(cancelled.state.messages.at(-1)?.body, "");
  const more = applyAgentEvent(split.state, { [key(1)]: { ...split.runs[key(1)], text: "Rest" } }, PROJECT, key(1), { type: "turn-completed" });
  assert.equal(more.state.messages.at(-1)?.body, "Rest");
});

const npmTest = { id: "s1", kind: "shell" as const, title: "Ran `npm test`", detail: "$ npm test\n" };

/** Folds events into one chat's run, starting from a fresh run unless `runs` is given. */
function fold(events: AgentEvent[], runs: AgentRuns = startRun({}, key(1), "gpt-6-sol"), state = base()) {
  let result = { state, runs, changed: false };
  for (const event of events) result = applyAgentEvent(result.state, result.runs, PROJECT, key(1), event);
  return result;
}

test("a step starts where the reply's text has got to, streams its output, and ends with its own detail", () => {
  const { runs } = fold([
    { type: "text-delta", messageId: "t", text: "Testing." },
    { type: "step-started", step: npmTest },
    { type: "step-output", id: "s1", text: "ok 2\n" },
  ]);
  assert.deepEqual(runs[key(1)].steps, [{ ...npmTest, status: "running", offset: 8, detail: "$ npm test\nok 2\n" }]);

  const ended = fold([{ type: "step-completed", id: "s1", status: "failed", detail: "$ npm test\nok 1\nok 2\n1 failing\n" }], runs).runs;
  assert.deepEqual(ended[key(1)].steps, [{ ...npmTest, status: "failed", offset: 8, detail: "$ npm test\nok 1\nok 2\n1 failing\n" }]);
  // Output after the end, or for a step the run doesn't have, changes nothing.
  assert.equal(fold([{ type: "step-output", id: "s1", text: "late" }], ended).runs, ended);
  assert.equal(fold([{ type: "step-completed", id: "nope", status: "done" }], ended).runs, ended);
});

test("a step that ends with a file keeps it", () => {
  const image = { id: "ig", kind: "image" as const, title: "Generating an image" };
  const { runs } = fold([
    { type: "step-started", step: image },
    { type: "step-completed", id: "ig", status: "done", title: "Generated an image", file: "/tmp/ig.png" },
  ]);
  assert.equal(runs[key(1)].steps[0].file, "/tmp/ig.png");
});

test("a step that ends with a routine keeps it", () => {
  const set = { id: "h1", kind: "other" as const, title: 'Set Heartbeat "watch CI"' };
  const { runs } = fold([
    { type: "step-started", step: set },
    { type: "step-completed", id: "h1", status: "done", routine: { id: "r1", name: "watch CI" } },
  ]);
  assert.deepEqual(runs[key(1)].steps[0].routine, { id: "r1", name: "watch CI" });
});

test("a step that ends without a detail keeps none, and a new title replaces the first", () => {
  const read = { id: "r1", kind: "read" as const, title: "Read `app.js`", detail: "$ cat app.js\n" };
  const { runs } = fold([
    { type: "step-started", step: read },
    { type: "step-output", id: "r1", text: "export const a = 1;\n" },
    { type: "step-completed", id: "r1", status: "done" },
    { type: "step-started", step: { id: "w1", kind: "search", title: "Searched the web" } },
    { type: "step-completed", id: "w1", status: "done", title: "Searched the web for `IANA`" },
  ]);
  assert.deepEqual(runs[key(1)].steps, [
    { id: "r1", kind: "read", title: "Read `app.js`", status: "done", offset: 0 },
    { id: "w1", kind: "search", title: "Searched the web for `IANA`", status: "done", offset: 0 },
  ]);
});

test("thinking streams its summary and ends with how long it took", () => {
  const { runs } = fold([
    { type: "step-started", step: { id: "th1", kind: "thinking", title: "Thinking" } },
    { type: "step-output", id: "th1", text: "Plan " },
    { type: "step-output", id: "th1", text: "it." },
  ]);
  assert.equal(runs[key(1)].steps[0].detail, "Plan it.");
  const ended = fold([{ type: "step-completed", id: "th1", status: "done", title: "Thought for 2s", detail: "Plan it.", durationMs: 2_100 }], runs).runs;
  assert.deepEqual(ended[key(1)].steps, [
    { id: "th1", kind: "thinking", title: "Thought for 2s", status: "done", offset: 0, detail: "Plan it.", durationMs: 2_100 },
  ]);
});

test("thinking cut off by a cancelled turn is saved as done, not failed", () => {
  const { state } = fold([
    { type: "step-started", step: { id: "th1", kind: "thinking", title: "Thinking" } },
    { type: "step-started", step: npmTest },
    { type: "turn-cancelled" },
  ]);
  assert.deepEqual(
    state.messages.at(-1)?.steps?.map((step) => step.status),
    ["done", "failed"],
  );
});

test("streamed output keeps its last 20,000 characters", () => {
  const { runs } = fold([
    { type: "step-started", step: { ...npmTest, detail: "" } },
    { type: "step-output", id: "s1", text: "a".repeat(15_000) },
    { type: "step-output", id: "s1", text: "b".repeat(15_000) },
  ]);
  assert.equal(runs[key(1)].steps[0].detail, `… truncated\n${"a".repeat(5_000)}${"b".repeat(15_000)}`);
  assert.equal(capOutput("short"), "short");
});

test("a step that starts with a huge detail is saved capped when the turn is cancelled", () => {
  const { state } = fold([{ type: "step-started", step: { ...npmTest, detail: `$ ${"x".repeat(60_000)}\n` } }, { type: "turn-cancelled" }]);
  assert.ok((state.messages.at(-1)?.steps?.[0].detail?.length ?? 0) <= 20_012);
});

test("step events for a chat with nothing running change nothing", () => {
  const state = base();
  for (const event of [
    { type: "step-started", step: npmTest },
    { type: "step-output", id: "s1", text: "x" },
    { type: "step-completed", id: "s1", status: "done" },
  ] as AgentEvent[]) {
    assert.deepEqual(applyAgentEvent(state, {}, PROJECT, key(1), event), { state, runs: {}, changed: false });
  }
});

test("a finished reply saves its steps where they happened in the trimmed text", () => {
  const { state } = fold([
    { type: "text-delta", messageId: "t", text: "\n  Testing." },
    { type: "step-started", step: npmTest },
    { type: "step-completed", id: "s1", status: "done", detail: "$ npm test\nok\n" },
    { type: "text-delta", messageId: "t", text: "\n\nAll green. " },
    { type: "turn-completed" },
  ]);
  const saved = state.messages.at(-1);
  assert.equal(saved?.body, "Testing.\n\nAll green.");
  assert.deepEqual(saved?.steps, [{ ...npmTest, status: "done", offset: 8, detail: "$ npm test\nok\n" }]);
});

test("a step still running when the turn ends is saved as done or failed with the turn", () => {
  const running = fold([
    { type: "text-delta", messageId: "t", text: "Testing." },
    { type: "step-started", step: npmTest },
    { type: "step-output", id: "s1", text: "ok 1\n" },
  ]).runs;
  const cancelled = fold([{ type: "turn-cancelled" }], running).state.messages.at(-1);
  assert.equal(cancelled?.body, "Testing.");
  assert.deepEqual(cancelled?.steps, [{ ...npmTest, status: "failed", offset: 8, detail: "$ npm test\nok 1\n" }]);
  assert.equal(fold([{ type: "turn-failed", message: "boom" }], running).state.messages.at(-1)?.steps?.[0].status, "failed");
  assert.equal(fold([{ type: "turn-completed" }], running).state.messages.at(-1)?.steps?.[0].status, "done");
});

test("a reply with steps and no text saves an empty body; one with neither says so", () => {
  const withSteps = fold([
    { type: "step-started", step: npmTest },
    { type: "step-completed", id: "s1", status: "done", detail: "$ npm test\n" },
    { type: "turn-completed" },
  ]).state.messages.at(-1);
  assert.equal(withSteps?.body, "");
  assert.deepEqual(
    withSteps?.steps?.map((step: ChatStep) => step.offset),
    [0],
  );
  const empty = fold([{ type: "turn-completed" }]).state.messages.at(-1);
  assert.equal(empty?.body, "The agent finished without a reply.");
  assert.equal(empty && "steps" in empty, false);
});

test("a steer saves finished steps with the reply so far; running ones carry on below the new message", () => {
  const { runs, state } = fold([
    { type: "text-delta", messageId: "t", text: "Testing." },
    { type: "step-started", step: { id: "r1", kind: "read", title: "Read `a.js`" } },
    { type: "step-completed", id: "r1", status: "done" },
    { type: "step-started", step: npmTest },
  ]);
  const split = splitRunForSteer(state, runs, PROJECT, key(1));
  assert.deepEqual(split.state.messages.at(-1)?.steps, [{ id: "r1", kind: "read", title: "Read `a.js`", status: "done", offset: 8 }]);
  assert.deepEqual(split.runs[key(1)].steps, [{ ...npmTest, status: "running", offset: 0 }]);
  assert.equal(split.runs[key(1)].text, "");

  // The running step finishes after the steer and is saved with the rest of the reply.
  const rest = fold(
    [{ type: "step-completed", id: "s1", status: "done", detail: "$ npm test\nok\n" }, { type: "turn-completed" }],
    split.runs,
    split.state,
  ).state.messages.at(-1);
  assert.equal(rest?.body, "");
  assert.deepEqual(rest?.steps, [{ ...npmTest, status: "done", offset: 0, detail: "$ npm test\nok\n" }]);
});

test("a steer with only finished steps and no text still saves them", () => {
  const { runs, state } = fold([
    { type: "step-started", step: npmTest },
    { type: "step-completed", id: "s1", status: "done", detail: "$ npm test\n" },
  ]);
  const split = splitRunForSteer(state, runs, PROJECT, key(1));
  assert.equal(split.changed, true);
  assert.equal(split.state.messages.at(-1)?.body, "");
  assert.equal(split.state.messages.at(-1)?.steps?.length, 1);
  // Nothing new after the split: the turn saves no second reply.
  const done = fold([{ type: "turn-completed" }], split.runs, split.state);
  assert.equal(done.changed, false);
  // Only a running step and no text: nothing to save yet.
  const onlyRunning = fold([{ type: "step-started", step: npmTest }]);
  assert.equal(splitRunForSteer(onlyRunning.state, onlyRunning.runs, PROJECT, key(1)).changed, false);
});

test("an open approval and question survive a steer and keep their steps; the turn's end drops them with the run", () => {
  const request = { ...approval("a"), stepId: "s1" };
  const { runs, state } = fold([
    { type: "text-delta", messageId: "t", text: "Testing." },
    { type: "step-started", step: npmTest },
    { type: "permission-request", ...request },
    {
      type: "question-request",
      requestId: "q-1",
      questions: [{ id: "0", header: "", question: "Which?", options: [], multiSelect: false, allowOther: true, secret: false }],
    },
  ]);
  const split = splitRunForSteer(state, runs, PROJECT, key(1));
  const run = split.runs[key(1)];
  assert.equal(run.approvals[0].stepId, "s1");
  assert.deepEqual(
    run.questions.map((question) => question.requestId),
    ["q-1"],
  );
  assert.deepEqual(
    run.steps.map((step) => step.id),
    ["s1"],
  );
  const ended = fold([{ type: "turn-cancelled" }], split.runs, split.state);
  assert.equal(ended.runs[key(1)], undefined);
  assert.equal(ended.state.messages.at(-1)?.steps?.[0].status, "failed");
});

test("subagent snapshots survive parent completion and late child results remain chat scoped", () => {
  let state = base();
  let runs = startRun({}, key(1), "codex");
  const agent = { id: "child", title: "Review", status: "running" as const, startedAt: 1, updatedAt: 2, transcript: [] };
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "subagent-update", agent }));
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "turn-completed" }));
  assert.equal(state.sessions[1].subagents?.[0].status, "running");
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "subagent-update", agent: { ...agent, status: "failed", updatedAt: 3 } }));
  assert.equal(state.sessions[1].subagents?.[0].status, "failed");
  assert.equal(state.sessions[2].subagents, undefined);
  assert.deepEqual(runs, {});
  assert.equal(JSON.parse(JSON.stringify(state)).sessions[1].subagents[0].title, "Review");
});
test("a subagent that runs again loses its old end, so its clock runs; its plan and totals come with the update", () => {
  let state = base();
  let runs = startRun({}, key(1), "codex");
  const agent = { id: "child", title: "Review", status: "completed" as const, startedAt: 1, updatedAt: 2, endedAt: 2, transcript: [] };
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "subagent-update", agent }));
  const { endedAt: _ended, ...running } = { ...agent, status: "running" as const, updatedAt: 3 };
  const tasks = [{ id: "0", content: "Check expiry", status: "in_progress" as const }];
  const progress = { steps: 2, said: "Checking expiry.", tools: { reads: 3 } };
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "subagent-update", agent: { ...running, tasks, progress } }));
  const child = state.sessions[1].subagents?.[0];
  assert.equal(child?.status, "running");
  assert.equal(Object.hasOwn(child ?? {}, "endedAt"), false);
  assert.deepEqual(child?.tasks, tasks);
  assert.deepEqual(child?.progress, progress);
});
test("an archived subagent that runs again, as a resumed session's background agent does, returns to the track", () => {
  let state = base();
  let runs = startRun({}, key(1), "claude");
  const agent = { id: "child", title: "Review", status: "failed" as const, startedAt: 1, updatedAt: 2, endedAt: 2, transcript: [] };
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "subagent-update", agent }));
  state = archiveFinishedSubagents(state, 1);
  assert.equal(state.sessions[1].subagents?.[0].archived, true);
  const { endedAt: _ended, ...running } = { ...agent, status: "running" as const, updatedAt: 3 };
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "subagent-update", agent: running }));
  assert.equal(state.sessions[1].subagents?.[0].archived, false);
  // One the user archived while it runs stays archived as it keeps running.
  state = { ...state, sessions: { ...state.sessions, 1: { ...state.sessions[1], subagents: [{ ...state.sessions[1].subagents![0], archived: true }] } } };
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "subagent-update", agent: { ...running, updatedAt: 4 } }));
  assert.equal(state.sessions[1].subagents?.[0].archived, true);
});
test("explicit subagent waiting clears when the parent resumes output", () => {
  let state = base(),
    runs = startRun({}, key(1), "codex");
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "subagents-waiting", waiting: true }));
  assert.equal(runs[key(1)].waitingForSubagents, true);
  ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "text-delta", messageId: "m", text: "Continuing" }));
  assert.equal(runs[key(1)].waitingForSubagents, false);
});
test("a rediscovered child keeps its saved transcript and original start time", () => {
  let state = base();
  const agent = {
    id: "child",
    title: "Review",
    status: "unknown" as const,
    startedAt: 1,
    updatedAt: 2,
    transcript: [{ id: "old", kind: "message" as const, text: "Earlier finding" }],
  };
  ({ state } = applyAgentEvent(state, {}, PROJECT, key(1), { type: "subagent-update", agent }));
  ({ state } = applyAgentEvent(state, {}, PROJECT, key(1), {
    type: "subagent-update",
    agent: { ...agent, status: "running", startedAt: 3, updatedAt: 3, transcript: [] },
  }));
  assert.equal(state.sessions[1].subagents?.[0].startedAt, 1);
  assert.equal(state.sessions[1].subagents?.[0].transcript[0].text, "Earlier finding");
});

test("answers to a question join the chat as the user's message, after the reply so far", () => {
  const state = base();
  const runs: AgentRuns = { [key(1)]: { text: "Which color? ", model: "gpt-6-sol", approvals: [], steps: [], questions: [], answered: {} } };
  const recorded = recordAnswers(state, runs, PROJECT, key(1), "Red");
  assert.deepEqual(
    recorded.state.messages.map(({ id, role, body }) => ({ id, role, body })),
    [
      { id: 10, role: "assistant", body: "Which color?" },
      { id: 11, role: "user", body: "Red" },
    ],
  );
  assert.equal(recorded.messageId, 11);
  assert.equal(recorded.state.next_id, 12);
  assert.deepEqual(recorded.runs[key(1)], { text: "", model: "gpt-6-sol", approvals: [], steps: [], questions: [], answered: {}, split: true });

  // Nothing streamed yet: only the answers are added, and the run still knows it was split.
  const empty: AgentRuns = { [key(1)]: { ...runs[key(1)], text: "" } };
  const alone = recordAnswers(state, empty, PROJECT, key(1), "Red");
  assert.deepEqual(
    alone.state.messages.map(({ role, body }) => ({ role, body })),
    [{ role: "user", body: "Red" }],
  );
  assert.equal(alone.runs[key(1)].split, true);

  for (const [testRuns, chatId, body] of [
    [runs, key(1), ""],
    [{}, key(1), "Red"],
    [runs, chatKey("/work/other", 1), "Red"],
  ] as Array<[AgentRuns, string, string]>) {
    const unchanged = recordAnswers(state, testRuns, PROJECT, chatId, body);
    assert.equal(unchanged.messageId, null);
    assert.equal(unchanged.state, state);
  }
});

test("a completed turn's credits are saved on its reply", () => {
  const { state } = applyAgentEvent(base(), startRun({}, key(1), "kiro"), PROJECT, key(1), { type: "turn-completed", credits: 0.04 });
  assert.equal(state.messages.at(-1).credits, 0.04);
  const failed = applyAgentEvent(base(), startRun({}, key(1), "kiro"), PROJECT, key(1), { type: "turn-failed", message: "x" });
  assert.equal(failed.state.messages.at(-1).credits, undefined);
});

test("context-usage follows the run and is saved on the chat when the turn ends", () => {
  let { state, runs, changed } = applyAgentEvent(base(), startRun({}, key(1), "codex"), PROJECT, key(1), { type: "context-usage", used: 1000, size: 4000 });
  assert.equal(changed, false);
  assert.deepEqual(runs[key(1)].contextUsage, { used: 1000, size: 4000 });
  ({ state, runs, changed } = applyAgentEvent(state, runs, PROJECT, key(1), { type: "turn-failed", message: "at capacity" }));
  assert.equal(changed, true);
  assert.deepEqual(state.sessions[1].contextUsage, { used: 1000, size: 4000 });
});

test("answers keep each question with what was picked or typed, in the request's order, with typed secrets masked", () => {
  const request: QuestionRequest = {
    requestId: "q",
    questions: [
      { id: "a", header: "Color", question: "Which color?", options: [{ label: "Red", description: "" }], multiSelect: false, allowOther: true, secret: false },
      { id: "b", header: "Token", question: "Your token?", options: [{ label: "Skip", description: "" }], multiSelect: false, allowOther: true, secret: true },
    ],
  };
  assert.deepEqual(answeredQuestions(request, { b: ["abc123"], a: ["Red", "teal"] }), [
    { header: "Color", question: "Which color?", answers: ["Red", "teal"] },
    { header: "Token", question: "Your token?", answers: ["••••••"] },
  ]);
  assert.deepEqual(answeredQuestions(request, { b: ["Skip"] }), [{ header: "Token", question: "Your token?", answers: ["Skip"] }]);
  assert.equal(answeredQuestions(request, null), null);
  assert.equal(answeredQuestions(undefined, { a: ["Red"] }), null);
});

test("a chat key names its computer when it is another Mac's", () => {
  const id = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  assert.equal(chatKey("/p", 3), "/p#3");
  assert.equal(chatKey("/p", 3, "local"), "/p#3");
  const remote = chatKey("/p", 3, id);
  assert.equal(remote, `${id}|/p#3`);
  assert.equal(projectOfKey(remote), `${id}|/p`);
  assert.equal(computerOfKey(remote), id);
  assert.equal(chatInProject(`${id}|/p`, remote), true);
  assert.equal(chatInProject("/p", remote), false, "this Mac's /p is another Project");
});

test("subagentActive: one still at work or waiting on an approval is active; one that ended is not", () => {
  for (const status of ["initializing", "running", "waiting"] as const) assert.equal(subagentActive({ status }), true);
  for (const status of ["completed", "failed", "cancelled", "unknown"] as const) assert.equal(subagentActive({ status }), false);
  assert.equal(subagentActive(undefined), false);
});

test("a /compact the user asked for: its divider goes from preparing to done at the boundary, and the empty turn saves no reply", () => {
  let state = base();
  state = {
    ...state,
    messages: [
      { id: 8, session_id: 2, body: "fix it", context: null, role: "user" },
      { id: 9, session_id: 2, body: "/compact", context: { kind: "compaction", status: "preparing", before: 897_000, size: 1_000_000 }, role: "user" },
    ],
  };
  let runs = startRun({}, key(2), "claude-opus-5-5");
  // The existing manual divider handles progress without adding another message.
  let result = applyAgentEvent(state, runs, PROJECT, key(2), { type: "context-compacting" });
  assert.equal(result.changed, false);
  assert.deepEqual(result.runs[key(2)].steps, []);
  ({ state, runs } = result);
  result = applyAgentEvent(state, runs, PROJECT, key(2), { type: "step-completed", id: "compact-1", status: "done", title: "Compacted context" });
  ({ state, runs } = result);
  result = applyAgentEvent(state, runs, PROJECT, key(2), { type: "context-compacted", trigger: "manual", before: 897_000, after: 42_000 });
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.messages[1].context, { kind: "compaction", status: "done", before: 897_000, after: 42_000, size: 1_000_000 });
  ({ state, runs } = result);
  result = applyAgentEvent(state, runs, PROJECT, key(2), { type: "context-usage", used: 42_000, size: 1_000_000 });
  ({ state, runs } = result);
  result = applyAgentEvent(state, runs, PROJECT, key(2), { type: "turn-completed" });
  assert.deepEqual(result.runs, {});
  assert.equal(result.state.messages.length, 2);
  assert.deepEqual(result.state.sessions["2"].contextUsage, { used: 42_000, size: 1_000_000 });
  assert.equal(result.changed, true);
});

test("a manual compaction that never reaches its boundary fails with the turn", () => {
  let state = base();
  state = { ...state, messages: [{ id: 8, session_id: 2, body: "fix it", context: null, role: "user" }] };
  const runs = startRun({}, key(2), "claude-opus-5-5");
  const pending = {
    ...state,
    messages: [
      ...state.messages,
      { id: 9, session_id: 2, body: "/compact", context: { kind: "compaction", status: "preparing", before: 190_000 }, role: "user" },
    ],
  };
  const failed = applyAgentEvent(pending, runs, PROJECT, key(2), { type: "turn-failed", message: "boom" });
  assert.deepEqual(failed.state.messages[1].context, { kind: "compaction", status: "failed", before: 190_000 });
  assert.equal(failed.state.messages.at(-1)?.body, "Agent error: boom");
  const cancelled = applyAgentEvent(pending, runs, PROJECT, key(2), { type: "turn-cancelled" });
  assert.equal(cancelled.state.messages[1].context.status, "failed");
  const silent = applyAgentEvent(pending, runs, PROJECT, key(2), { type: "turn-completed" });
  assert.equal(silent.state.messages[1].context.status, "failed");
  assert.equal(silent.state.messages.length, 2);
});

test("automatic compaction splits a reply around one saved divider, then the turn continues", () => {
  let state = base();
  let runs = startRun({}, key(2), "claude-opus-5-5");
  const apply = (event: AgentEvent) => ({ state, runs } = applyAgentEvent(state, runs, PROJECT, key(2), event));
  apply({ type: "context-usage", used: 180_000, size: 200_000 });
  apply({ type: "text-delta", messageId: "t", text: "Before compaction." });
  apply({ type: "step-started", step: { id: "tool", kind: "command", title: "Running command" } });
  apply({ type: "context-compacting" });
  assert.deepEqual(
    state.messages.map((m) => m.body),
    ["Before compaction.", ""],
  );
  const id = state.messages[1].id;
  assert.deepEqual(state.messages[1].context, { kind: "compaction", status: "preparing", before: 180_000, size: 200_000 });
  assert.equal(state.messages[1].role, "assistant");
  assert.equal(runs[key(2)].steps[0].id, "tool");
  assert.equal(runs[key(2)].steps[0].offset, 0);
  apply({ type: "context-compacting" });
  assert.equal(state.messages.length, 2, "repeated start does not add a second divider");
  apply({ type: "context-compacted", trigger: "auto", before: 190_000, after: 20_000 });
  assert.equal(state.messages[1].id, id);
  assert.deepEqual(state.messages[1].context, { kind: "compaction", status: "done", before: 190_000, after: 20_000, size: 200_000 });
  apply({ type: "context-usage", used: 20_000, size: 200_000 });
  apply({ type: "step-completed", id: "tool", status: "done" });
  apply({ type: "text-delta", messageId: "t", text: "After compaction." });
  apply({ type: "turn-completed" });
  assert.deepEqual(
    state.messages.map((m) => m.body),
    ["Before compaction.", "", "After compaction."],
  );
  assert.deepEqual(
    state.messages[2].steps?.map((s) => s.id),
    ["tool"],
  );
  assert.deepEqual(state.sessions[2].contextUsage, { used: 20_000, size: 200_000 });
  assert.equal(state.next_id, 13);
  assert.deepEqual(runs, {});
});

test("a boundary without a start saves a divider without inventing token counts or an empty reply", () => {
  const state = base();
  const runs = startRun({}, key(1), "gpt-6");
  const result = applyAgentEvent(state, runs, PROJECT, key(1), { type: "context-compacted", trigger: "auto" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.messages[0].context, { kind: "compaction", status: "done" });
  const ended = applyAgentEvent(result.state, result.runs, PROJECT, key(1), { type: "turn-completed" });
  assert.equal(ended.state.messages.length, 1);
});

test("an automatic compaction interrupted before its boundary saves a failed divider", () => {
  for (const event of [{ type: "turn-completed" }, { type: "turn-cancelled" }, { type: "turn-failed", message: "boom" }] as AgentEvent[]) {
    const started = applyAgentEvent(base(), startRun({}, key(2), "claude"), PROJECT, key(2), { type: "context-compacting" });
    const ended = applyAgentEvent(started.state, started.runs, PROJECT, key(2), event);
    assert.equal(ended.changed, true);
    assert.equal(ended.state.messages[0].context?.kind, "compaction");
    assert.equal((ended.state.messages[0].context as { status: string }).status, "failed");
  }
});

test("a session without plan takes a native list", () => {
  let runs = startRun({}, key(1), "gpt-5.5");
  const first = applyAgentEvent(base(), runs, PROJECT, key(1), {
    type: "tasks-updated",
    tasks: [{ id: "0", content: "Read", status: "in_progress" }],
  });
  assert.equal(first.changed, true);
  assert.equal(first.state.sessions["1"].plan?.source, "native");
  assert.deepEqual(first.state.sessions["1"].plan?.tasks, [{ id: "0", title: "Read", status: "in_progress" }]);
  assert.equal("tasks" in (first.runs[key(1)] ?? {}), false);
});

test("plan-updated stores the plan and native lists stop once Milagre owns it", () => {
  const plan = { source: "milagre" as const, tasks: [{ id: "1", title: "Mine", status: "pending" as const }], phases: [], updatedAt: 1 };
  const runs = startRun({}, key(1), "gpt-5.5");
  const owned = applyAgentEvent(base(), runs, PROJECT, key(1), { type: "plan-updated", plan });
  assert.equal(owned.changed, true);
  assert.deepEqual(owned.state.sessions["1"].plan, plan);
  const ignored = applyAgentEvent(owned.state, owned.runs, PROJECT, key(1), {
    type: "tasks-updated",
    tasks: [{ id: "0", content: "Other", status: "pending" }],
  });
  assert.equal(ignored.changed, false);
  const cleared = applyAgentEvent(owned.state, owned.runs, PROJECT, key(1), { type: "plan-updated", plan: null });
  assert.equal(cleared.state.sessions["1"].plan, undefined);
});

test("background-tasks replaces the Chat's set of background tasks, outside any turn, and an empty set clears it", () => {
  const tasks = [{ id: "b1", kind: "local_bash", title: "sleep 75", startedAt: 1 }];
  const saved = applyAgentEvent(base(), {}, PROJECT, key(2), { type: "background-tasks", tasks });
  assert.equal(saved.changed, true);
  assert.deepEqual(saved.state.sessions["2"].backgroundTasks, tasks);
  assert.equal(applyAgentEvent(saved.state, {}, PROJECT, key(2), { type: "background-tasks", tasks: [...tasks] }).changed, false);
  const cleared = applyAgentEvent(saved.state, {}, PROJECT, key(2), { type: "background-tasks", tasks: [] });
  assert.equal(cleared.changed, true);
  assert.equal("backgroundTasks" in cleared.state.sessions["2"], false);
  assert.equal(applyAgentEvent(base(), {}, PROJECT, key(2), { type: "background-tasks", tasks: [] }).changed, false);
});

test("an identical native list changes nothing, a different one does", () => {
  const runs = startRun({}, key(1), "gpt-5.5");
  const list = [
    { id: "0", content: "Read", activeForm: "Reading", status: "in_progress" as const },
    { id: "1", content: "Write", status: "pending" as const },
  ];
  const first = applyAgentEvent(base(), runs, PROJECT, key(1), { type: "tasks-updated", tasks: list });
  assert.equal(first.changed, true);
  const again = applyAgentEvent(first.state, first.runs, PROJECT, key(1), { type: "tasks-updated", tasks: list.map((task) => ({ ...task })) });
  assert.equal(again.changed, false);
  assert.equal(again.state, first.state);
  const moved = applyAgentEvent(first.state, first.runs, PROJECT, key(1), { type: "tasks-updated", tasks: [{ ...list[0], status: "completed" }, list[1]] });
  assert.equal(moved.changed, true);
  assert.equal(moved.state.sessions["1"].plan?.tasks[0].status, "completed");
});

test("the plan outlives the turn", () => {
  const plan = { source: "milagre" as const, tasks: [{ id: "1", title: "Mine", status: "pending" as const }], phases: [], updatedAt: 1 };
  const runs = startRun({}, key(1), "gpt-5.5");
  const owned = applyAgentEvent(base(), runs, PROJECT, key(1), { type: "plan-updated", plan });
  const ended = applyAgentEvent(owned.state, owned.runs, PROJECT, key(1), { type: "turn-completed" });
  assert.deepEqual(ended.state.sessions["1"].plan, plan);
  assert.equal(ended.runs[key(1)], undefined);
});

test("suggestions belong only to the last completed Claude turn and clear on every input boundary", () => {
  const chat = key(2);
  let state = base();
  let runs: AgentRuns = {};
  const fold = (event: AgentEvent) => {
    const result = applyAgentEvent(state, runs, PROJECT, chat, event);
    ({ state, runs } = result);
    return result;
  };
  const suggestion: AgentEvent = { type: "prompt-suggestion", text: "Add tests", turnId: "turn-a" };
  assert.equal(fold(suggestion).changed, false);
  fold({ type: "message-sent", model: "claude-opus-5-5" });
  fold({ type: "turn-started", turnId: "turn-a" });
  assert.equal(fold(suggestion).changed, false, "a running turn never accepts one");
  fold({ type: "text-delta", messageId: "turn-a", text: "Done" });
  fold({ type: "message-sent", model: "claude-opus-5-5" });
  assert.equal(runs[chat].split, true);
  assert.equal(fold({ type: "turn-completed" }).changed, true, "the empty split completion saves eligibility");
  assert.equal(state.sessions[2].suggestionTurnId, "turn-a");
  assert.equal(fold({ ...suggestion, turnId: "older" }).changed, false);
  const count = state.messages.length;
  assert.equal(fold(suggestion).changed, true);
  assert.deepEqual(state.sessions[2].suggestion, { text: "Add tests", turnId: "turn-a" });
  assert.equal(state.messages.length, count, "a suggestion writes no transcript message");
  assert.equal(state.sessions[2].unread, undefined);
  const accepted = state;
  for (const event of [
    { type: "message-sent", model: "claude-opus-5-5" },
    { type: "turn-started", turnId: "new" },
    { type: "session-reset" },
  ] as AgentEvent[]) {
    state = structuredClone(accepted);
    delete state.sessions[2].native_session_id;
    runs = {};
    assert.equal(fold(event).changed, true);
    assert.equal(state.sessions[2].suggestion, undefined);
    assert.equal(state.sessions[2].suggestionTurnId, undefined);
    assert.equal(fold(suggestion).changed, false);
  }
  for (const terminal of [{ type: "turn-cancelled" }, { type: "turn-failed", message: "Oops" }] as AgentEvent[]) {
    state = base();
    runs = {};
    fold({ type: "turn-started", turnId: "turn-a" });
    fold(terminal);
    assert.equal(fold(suggestion).changed, false);
  }
});

const step = (id: string) => ({ type: "step-started" as const, step: { id, kind: "command" as const, title: id } });

test("the agent's answer to a steering message is saved as its own reply, not folded between steps", () => {
  let applied = applyAgentEvent(
    base(),
    { [key(1)]: { text: "", model: "m", approvals: [], steps: [], questions: [], answered: {} } },
    PROJECT,
    key(1),
    step("s1"),
  );
  applied = applyAgentEvent(applied.state, applied.runs, PROJECT, key(1), { type: "message-sent", model: "m" });
  assert.equal(applied.runs[key(1)].steered, true);
  applied = applyAgentEvent(applied.state, applied.runs, PROJECT, key(1), { type: "text-delta", messageId: null, text: "Because 27 isn't installed." });
  const before = applied.state.messages.length;
  applied = applyAgentEvent(applied.state, applied.runs, PROJECT, key(1), step("s2"));
  assert.equal(applied.state.messages.at(-1)?.body, "Because 27 isn't installed.");
  assert.equal(applied.state.messages.length, before + 1);
  assert.equal(applied.runs[key(1)].steered, undefined);
  assert.deepEqual(
    applied.runs[key(1)].steps.map((item) => item.id),
    ["s1", "s2"],
  );
  // Later text between steps folds as before.
  applied = applyAgentEvent(applied.state, applied.runs, PROJECT, key(1), { type: "text-delta", messageId: null, text: "Next." });
  applied = applyAgentEvent(applied.state, applied.runs, PROJECT, key(1), step("s3"));
  assert.equal(applied.state.messages.length, before + 1);
});
