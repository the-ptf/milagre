import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentQuestion, AgentSession } from "@milagre/shared/model";
import { subchatSummary, type SubchatRequest } from "@milagre/shared/subchat-states";
import { answerArguments, approvalArguments, inlineQuestion, isRecommended, pillSpoken, subchatStates, type HeartbeatRoutine } from "./subchat-view.ts";

const now = 1_000_000_000;
const session = (id: number, extra: Record<string, unknown> = {}) =>
  ({ id, agent_name: `Chat ${id}`, title: `Chat ${id}`, ...extra }) as unknown as AgentSession;
const question = (extra: Partial<AgentQuestion> = {}): AgentQuestion => ({
  id: "q1",
  header: "Library",
  question: "Which library?",
  options: [{ label: "Zod" }, { label: "Valibot (Recommended)" }],
  multiSelect: false,
  allowOther: true,
  secret: false,
  ...extra,
});
const ask = (extra: Partial<AgentQuestion> = {}): SubchatRequest => ({ kind: "question", requestId: "r1", questions: [question(extra)] });

test("states come from the sessions, runs, Heartbeats and reports, what needs the user first", () => {
  const heartbeat: HeartbeatRoutine = { enabled: true, nextRunAt: now + 5 * 60_000, runCount: 2, maxRuns: 10, target: { kind: "chat", chatId: "/p#4" } };
  const states = subchatStates({
    keys: ["/p#2", "/p#3", "/p#4", "/p#5", "/p#9"],
    sessions: {
      2: session(2),
      3: session(3),
      4: session(4),
      5: session(5, { summary: { lastOutcome: "failed" } }),
    },
    runs: {
      "/p#2": { text: "Reading files", startedAt: now - 65_000, approvals: [], questions: [], answered: {} },
      "/p#3": { text: "", approvals: [], questions: [{ requestId: "r1", questions: [question()] }], answered: {} },
    },
    routines: [heartbeat],
    routinesOn: true,
    reports: new Map([["/p#5", "Tests broke"]]),
    now,
  });
  assert.deepEqual(
    states.map((state) => [state.key, state.kind]),
    [
      ["/p#3", "needs-you"],
      ["/p#5", "failed"],
      ["/p#2", "working"],
      ["/p#4", "holding"],
    ],
    "a Chat the session no longer lists (9) is skipped",
  );
  assert.equal(states[0]?.title, "Chat 3");
  assert.equal(states[2]?.elapsed, "1m 05s");
  assert.equal(states[1]?.detail, "Tests broke");
  assert.match(states[3]?.detail ?? "", /next beat in 5 min/);
});

test("with the Mac's Routines off, or the Heartbeat ended, a Chat is not holding", () => {
  const base = {
    keys: ["/p#4"],
    sessions: { 4: session(4) },
    runs: undefined,
    reports: new Map<string, string>(),
    now,
  };
  const routine = (extra: Partial<HeartbeatRoutine> = {}): HeartbeatRoutine => ({
    enabled: true,
    runCount: 0,
    target: { kind: "chat", chatId: "/p#4" },
    ...extra,
  });
  assert.equal(subchatStates({ ...base, routines: [routine()], routinesOn: true })[0]?.kind, "holding");
  assert.equal(subchatStates({ ...base, routines: [routine()], routinesOn: false })[0]?.kind, "done");
  assert.equal(subchatStates({ ...base, routines: [routine({ completedAt: 1 })], routinesOn: true })[0]?.kind, "done");
  assert.equal(subchatStates({ ...base, routines: [routine({ enabled: false })], routinesOn: true })[0]?.kind, "done");
  assert.equal(subchatStates({ ...base, routines: [routine({ target: { kind: "new-chat" } })], routinesOn: true })[0]?.kind, "done");
});

test("the pill is spoken from its summary", () => {
  const states = subchatStates({
    keys: ["/p#1", "/p#2"],
    sessions: { 1: session(1), 2: session(2) },
    runs: { "/p#1": { text: "x", approvals: [], questions: [], answered: {} } },
    routines: [],
    routinesOn: false,
    reports: new Map(),
    now,
  });
  assert.equal(pillSpoken(subchatSummary(states)), "Subchats, 1 working, 1 done");
});

test("only one single-choice question is answered from the row, the recommended option first", () => {
  assert.deepEqual(inlineQuestion(ask())?.options, ["Valibot (Recommended)", "Zod"]);
  assert.equal(inlineQuestion(ask({ multiSelect: true })), null);
  assert.equal(inlineQuestion(ask({ secret: true })), null);
  assert.equal(inlineQuestion(ask({ options: [] })), null);
  const two: SubchatRequest = { kind: "question", requestId: "r1", questions: [question(), question({ id: "q2" })] };
  assert.equal(inlineQuestion(two), null);
  assert.equal(inlineQuestion(undefined), null);
  assert.equal(isRecommended("Valibot (recommended)"), true);
  assert.equal(isRecommended("Zod"), false);
});

test("an answer and a decision carry what the Chat's own cards send", () => {
  const request = ask() as Extract<SubchatRequest, { kind: "question" }>;
  assert.deepEqual(answerArguments("/p#3", request, question(), "Zod"), {
    chatId: "/p#3",
    requestId: "r1",
    answers: { q1: ["Zod"] },
    summary: "Library: Zod",
  });
  const approval = { kind: "approval", request: { requestId: "a1" } } as Extract<SubchatRequest, { kind: "approval" }>;
  assert.deepEqual(approvalArguments("/p#3", approval, "deny"), { chatId: "/p#3", requestId: "a1", decision: "deny" });
});
