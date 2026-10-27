import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, CoordinatorState, ModelOption, PermissionRequest, QuestionRequest } from "../model";
import {
  applyRunEvents,
  chatKey,
  createCoalescer,
  isUrgentRunEvent,
  chatsAskingUser,
  chatsInBackground,
  chatsRunning,
  chatsWaitingForUser,
  clearAnswered,
  dropComputerRuns,
  eventIsNew,
  keepComputers,
  markAnswered,
  modelForChat,
  replaceComputerEntries,
  modelForOpenChat,
  sentDecision,
  sentReply,
} from "./agent-runs.ts";
import type { AgentRuns, FrameScheduler, QueuedRunEvent } from "./agent-runs.ts";
// Runs are set up with the reducer the main process saves turns with.
import { applyAgentEvent, startRun } from "@milagre/shared/agent-runs";

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

test("picks a model from the chat's provider", () => {
  const catalog: ModelOption[] = [
    { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "codex", description: "" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "claude", description: "" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "claude", description: "" },
  ];
  const [codex, opus, sonnet] = catalog;
  const lastUsed = [{ id: 1, session_id: 2, body: "hi", context: null, role: "user" as const, model: "claude-sonnet-5-5" }];

  assert.equal(modelForChat(codex, undefined, [], catalog), codex);
  assert.equal(modelForChat(opus, "claude", lastUsed, catalog), opus);
  assert.equal(modelForChat(codex, "claude", lastUsed, catalog), sonnet);
  assert.equal(modelForChat(codex, "claude", [], catalog), opus);
});

test("each open chat shows its own model", () => {
  const catalog: ModelOption[] = [
    { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "codex", description: "" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "claude", description: "" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "claude", description: "" },
  ];
  const [codex, opus, sonnet] = catalog;
  const ranSonnet = [{ id: 1, session_id: 2, body: "hi", context: null, role: "user" as const, model: "claude-sonnet-5-5" }];

  assert.equal(modelForOpenChat("claude-opus-5-5", "claude", ranSonnet, catalog, codex), opus);
  assert.equal(modelForOpenChat(undefined, "claude", ranSonnet, catalog, opus), sonnet);
  assert.equal(modelForOpenChat("gpt-6-sol", "claude", ranSonnet, catalog, codex), sonnet);
  assert.equal(modelForOpenChat(undefined, "claude", [], catalog, sonnet), sonnet);
  assert.equal(modelForOpenChat(undefined, "claude", [], catalog, codex), opus);
  assert.equal(modelForOpenChat(undefined, undefined, [], catalog, codex), codex);
});

test("an answer is kept on its chat's run, and a second chat with the same request id is unaffected", () => {
  const runs: AgentRuns = { [key(1)]: startRun({}, key(1), "gpt-6-sol")[key(1)], [key(2)]: startRun({}, key(2), "claude-opus-5-5")[key(2)] };
  assert.deepEqual(runs[key(1)].answered, {});
  const answered = markAnswered(runs, key(1), "7", "allow");
  assert.deepEqual(answered[key(1)].answered, { "7": "allow" });
  assert.deepEqual(answered[key(2)].answered, {});
  assert.equal(markAnswered({}, key(1), "7", "allow").constructor, Object);
  assert.deepEqual(markAnswered({}, key(1), "7", "allow"), {});

  assert.deepEqual(clearAnswered(answered, key(1), "7")[key(1)].answered, {});
  assert.equal(clearAnswered(answered, key(1), "other"), answered);
  assert.equal(clearAnswered({}, key(1), "7").constructor, Object);
  const empty = {};
  assert.equal(clearAnswered(empty, key(1), "7"), empty);

  const opened = applyAgentEvent(base(), {}, PROJECT, key(1), { type: "turn-started", turnId: "t" } as AgentEvent);
  assert.deepEqual(opened.runs[key(1)].answered, {});
});

test("a resolved request drops its answer", () => {
  const runs = markAnswered(startRun({}, key(1), "gpt-6-sol"), key(1), "7", "deny");
  const resolved = applyAgentEvent(base(), runs, PROJECT, key(1), { type: "permission-resolved", requestId: "7", decision: "deny" });
  assert.deepEqual(resolved.runs[key(1)].answered, {});
});

test("chatsWaitingForUser lists only this project's chats with a pending approval or question", () => {
  const request = { requestId: "r1" } as PermissionRequest;
  const run = (approvals: PermissionRequest[]) => ({ text: "", model: "m", approvals, steps: [], questions: [], answered: {} });
  const runs: AgentRuns = {
    [key(1)]: run([request]),
    [key(2)]: run([]),
    [key(3)]: run([request, { requestId: "r2" } as PermissionRequest]),
    [chatKey("/work/app#other", 4)]: run([request]),
    [chatKey("/work/other", 5)]: run([request]),
  };
  assert.deepEqual([...chatsWaitingForUser(runs, PROJECT)].sort(), [1, 3]);
  const asking: AgentRuns = { [key(6)]: { ...run([]), questions: [question("q1")] }, [key(7)]: run([]) };
  assert.deepEqual([...chatsWaitingForUser(asking, PROJECT)], [6]);
  assert.equal(chatsWaitingForUser({}, PROJECT).size, 0);
});

test("chatsAskingUser lists chats with a question and no approval ahead of it", () => {
  const request = { requestId: "r1" } as PermissionRequest;
  const run = (approvals: PermissionRequest[], questions = [question("q1")]) => ({ text: "", model: "m", approvals, steps: [], questions, answered: {} });
  const runs: AgentRuns = { [key(1)]: run([]), [key(2)]: run([request]), [key(3)]: run([], []), [chatKey("/work/other", 4)]: run([]) };
  assert.deepEqual([...chatsAskingUser(runs, PROJECT)], [1]);
});

test("chatsRunning lists only this project's chats with a run", () => {
  const run = { text: "", model: "m", approvals: [], steps: [], questions: [], answered: {} };
  const runs: AgentRuns = { [key(1)]: run, [key(4)]: run, [chatKey("/work/app#other", 2)]: run, [chatKey("/work/other", 3)]: run };
  assert.deepEqual([...chatsRunning(runs, PROJECT)].sort(), [1, 4]);
});

test("chatsInBackground counts the background agents of chats whose turn ended; a failed turn or a run shows otherwise", () => {
  const sessions = base().sessions;
  const agent = (id: string, status: string, background = true) =>
    ({ id, status, background }) as unknown as NonNullable<CoordinatorState["sessions"][string]["subagents"]>[number];
  sessions["1"] = { ...sessions["1"], provider: "claude", subagents: [agent("a", "completed"), agent("b", "running"), agent("c", "running")] };
  sessions["2"] = { ...sessions["2"], provider: "claude", subagents: [agent("d", "running", false)] };
  const run = { text: "", model: "m", approvals: [], steps: [], questions: [], answered: {} };
  assert.deepEqual([...chatsInBackground({}, PROJECT, sessions)], [[1, 2]]);
  assert.equal(chatsRunning({}, PROJECT).size, 0);
  assert.deepEqual([...chatsInBackground({ [key(1)]: run }, PROJECT, sessions)], []);
  sessions["1"] = { ...sessions["1"], summary: { count: 2, lastOutcome: "failed" } };
  assert.deepEqual([...chatsInBackground({}, PROJECT, sessions)], []);
});

const question = (requestId: string): QuestionRequest => ({
  requestId,
  questions: [
    {
      id: "0",
      header: "Color",
      question: "Which color?",
      options: [{ label: "Red" }, { label: "Green" }],
      multiSelect: false,
      allowOther: true,
      secret: false,
    },
  ],
});

test("questions wait on the run, oldest first, until they're resolved", () => {
  const state = base();
  let runs = startRun({}, key(1), "claude-opus-5-5");
  for (const requestId of ["a", "b"]) runs = applyAgentEvent(state, runs, PROJECT, key(1), { type: "question-request", ...question(requestId) }).runs;
  assert.deepEqual(runs[key(1)].questions, [question("a"), question("b")]);
  assert.deepEqual(runs[key(1)].approvals, []);

  runs = markAnswered(runs, key(1), "a", "answered");
  runs = applyAgentEvent(state, runs, PROJECT, key(1), { type: "question-resolved", requestId: "a", outcome: "answered" }).runs;
  assert.deepEqual(
    runs[key(1)].questions.map((item) => item.requestId),
    ["b"],
  );
  assert.deepEqual(runs[key(1)].answered, {});

  const unchanged = applyAgentEvent(state, runs, PROJECT, key(1), { type: "question-resolved", requestId: "missing", outcome: "cancelled" });
  assert.equal(unchanged.runs, runs);
  assert.equal(applyAgentEvent(state, {}, PROJECT, key(1), { type: "question-request", ...question("c") }).runs[key(1)], undefined);
  assert.equal(applyAgentEvent(state, runs, PROJECT, key(1), { type: "turn-cancelled" }).runs[key(1)], undefined);
});

test("what was sent reads back as a decision for approvals and a reply for questions", () => {
  let runs = startRun({}, key(1), "gpt-6-sol");
  runs = markAnswered(markAnswered(markAnswered(runs, key(1), "p", "allow-for-chat"), key(1), "q", "dismissed"), key(1), "r", "answered");
  assert.equal(sentDecision(runs[key(1)], "p"), "allow-for-chat");
  assert.equal(sentDecision(runs[key(1)], "q"), null);
  assert.equal(sentReply(runs[key(1)], "q"), "dismissed");
  assert.equal(sentReply(runs[key(1)], "r"), "answered");
  assert.equal(sentReply(runs[key(1)], "p"), null);
  assert.equal(sentReply(undefined, "q"), null);
});

test("a computer's snapshot replaces only its own turns, and a removed computer takes only its own", () => {
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const run = (text: string) => ({ text, model: "", startedAt: 0, steps: [], approvals: [], questions: [], answered: {} });
  const runs = { "/p#1": run("mine"), [`${ID}|/p#1`]: run("studio old"), [`${OTHER}|/p#1`]: run("arketa") };
  const next = replaceComputerEntries(runs, ID, { [`${ID}|/p#2`]: run("studio new"), "/p#9": run("not studio's") });
  assert.deepEqual(Object.keys(next).sort(), ["/p#1", `${ID}|/p#2`, `${OTHER}|/p#1`].sort());
  assert.equal(next["/p#1"].text, "mine", "this Mac's chat at the same path is untouched");
  const local = replaceComputerEntries(next, "local", { "/p#3": run("mine new") });
  assert.deepEqual(Object.keys(local).sort(), ["/p#3", `${ID}|/p#2`, `${OTHER}|/p#1`].sort());
  assert.deepEqual(Object.keys(dropComputerRuns(local, ID)).sort(), ["/p#3", `${OTHER}|/p#1`].sort());
});

test("each computer's events are compared with its own snapshot number", () => {
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const taken = new Map([
    ["local", 50],
    [ID, 5],
  ]);
  assert.equal(eventIsNew(taken, `${ID}|/p#1`, 6), true, "a computer's low numbers are not judged by this Mac's");
  assert.equal(eventIsNew(taken, `${ID}|/p#1`, 5), false);
  assert.equal(eventIsNew(taken, "/p#1", 6), false);
  assert.equal(eventIsNew(taken, "/p#1", 51), true);
  assert.equal(eventIsNew(new Map(), `${ID}|/p#1`, 1), true);
  assert.equal(eventIsNew(taken, "/p#1", undefined), true);
});

test("keepComputers drops the entries of computers that are gone and keeps this Mac's", () => {
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const record = { "/p#1": 1, [`${ID}|/p#1`]: 2, [`${OTHER}|/p#1`]: 3 };
  assert.deepEqual(Object.keys(keepComputers(record, new Set([OTHER]))).sort(), ["/p#1", `${OTHER}|/p#1`].sort());
  assert.deepEqual(Object.keys(keepComputers(record, new Set())), ["/p#1"]);
  assert.equal(keepComputers(record, new Set([ID, OTHER])), record, "nothing to drop leaves the same object");
});

/** A frame that only comes when the test says so; counts how often one was asked for. */
function manualFrames() {
  let pending: (() => void) | null = null;
  let asked = 0;
  const schedule: FrameScheduler = (flush) => {
    asked++;
    pending = flush;
    return () => {
      if (pending === flush) pending = null;
    };
  };
  return {
    schedule,
    asked: () => asked,
    waiting: () => pending !== null,
    frame() {
      const run = pending;
      pending = null;
      run?.();
    },
  };
}

test("streamed events in one frame land as one state, in arrival order", () => {
  const frames = manualFrames();
  let runs: AgentRuns = {};
  let applied = 0;
  const events = createCoalescer<QueuedRunEvent>((batch) => {
    applied++;
    runs = applyRunEvents(runs, batch);
  }, frames.schedule);
  events.push({ chatId: key(1), event: { type: "turn-started", turnId: "t1" }, model: "gpt-6-sol" }, true);
  assert.equal(applied, 1, "a turn's start lands at once");
  const before = runs;
  for (const text of ["Hel", "lo, ", "wor", "ld"]) events.push({ chatId: key(1), event: { type: "text-delta", messageId: "m1", text }, model: "" });
  // Another chat's stream in the same frame shares the flush.
  events.push({ chatId: key(2), event: { type: "turn-started", turnId: "t2" }, model: "claude-opus-5-5" }, false);
  events.push({ chatId: key(2), event: { type: "text-delta", messageId: "m2", text: "Other" }, model: "" });
  assert.equal(applied, 1, "deltas wait for the frame");
  assert.equal(runs, before);
  assert.equal(frames.asked(), 1, "one frame for the whole batch");
  frames.frame();
  assert.equal(applied, 2, "one state for every event of the frame");
  const expected = [
    { chatId: key(1), event: { type: "turn-started", turnId: "t1" }, model: "gpt-6-sol" },
    ...["Hel", "lo, ", "wor", "ld"].map((text) => ({ chatId: key(1), event: { type: "text-delta", messageId: "m1", text }, model: "" })),
    { chatId: key(2), event: { type: "turn-started", turnId: "t2" }, model: "claude-opus-5-5" },
    { chatId: key(2), event: { type: "text-delta", messageId: "m2", text: "Other" }, model: "" },
  ] as QueuedRunEvent[];
  assert.deepEqual(runs, applyRunEvents({}, expected), "same result as applying each event on its own");
  frames.frame();
  assert.equal(applied, 2, "an empty frame applies nothing");
});

test("an urgent event flushes what streamed before it, with it, in one state", () => {
  const frames = manualFrames();
  const batches: QueuedRunEvent[][] = [];
  const events = createCoalescer<QueuedRunEvent>((batch) => batches.push(batch), frames.schedule);
  const delta = (text: string): QueuedRunEvent => ({ chatId: key(1), event: { type: "text-delta", messageId: "m1", text }, model: "" });
  const ended: QueuedRunEvent = { chatId: key(1), event: { type: "turn-completed" }, model: "" };
  events.push(delta("a"));
  events.push(delta("b"));
  events.push(ended, isUrgentRunEvent(ended.event));
  assert.deepEqual(batches, [[delta("a"), delta("b"), ended]]);
  assert.equal(frames.waiting(), false, "the frame is cancelled once flushed");
  events.push(delta("c"));
  events.flush();
  assert.deepEqual(batches.at(-1), [delta("c")], "flush() applies the queue before another write");
  events.push(delta("d"));
  events.dispose();
  frames.frame();
  assert.equal(batches.length, 2, "dispose drops the queue");
});

test("only events that change what the user must see now skip the frame", () => {
  for (const type of ["turn-started", "turn-completed", "turn-cancelled", "turn-failed", "permission-request", "question-request", "message-sent"])
    assert.equal(isUrgentRunEvent({ type } as Parameters<typeof isUrgentRunEvent>[0]), true, type);
  for (const type of ["text-delta", "step-output", "step-draft", "context-usage", "subagent-update"])
    assert.equal(isUrgentRunEvent({ type } as Parameters<typeof isUrgentRunEvent>[0]), false, type);
});
