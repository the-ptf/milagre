import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRun } from "@milagre/shared/agent-runs";
import type { AgentSession } from "@milagre/shared/model";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { boardCounts, boardItem, columnItems, modelAndEffort, projectName, relativeAge } from "./orchestrator-board.ts";

const task = (patch: Partial<OrchestratorTask> = {}): OrchestratorTask => ({
  id: "t1",
  prompt: "fix the rest timer",
  title: "Fix the rest timer",
  projectPath: "/code/gym",
  worktreeId: "1",
  sessionId: 4,
  computer: null,
  remoteComputerId: null,
  remoteTaskId: null,
  role: "build",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  accountId: null,
  reason: { project: "Matched “gym”", role: null, account: null, computer: null },
  state: "started",
  error: null,
  createdAt: 1000,
  permissionMode: "auto",
  answered: [],
  images: 0,
  limit: null,
  outcome: "pull-request",
  ...patch,
});
const run = (patch: Partial<AgentRun> = {}) =>
  ({ text: "Editing RestTimer.swift", model: "x", steps: [], approvals: [], questions: [], answered: {}, ...patch }) as AgentRun;
const chat = (patch: Partial<AgentSession> = {}) => ({ id: 4, worktree_id: 1, agent_name: "claude", status: "idle", ...patch }) as AgentSession;

test("tasks the host is still routing, can't place or failed to start sit in their own cards", () => {
  assert.deepEqual(
    [boardItem(task({ state: "routing" }), undefined, null, 0), boardItem(task({ state: "needs-project" }), undefined, null, 0)].map((item) => [
      item.column,
      item.kind,
    ]),
    [
      ["running", "deciding"],
      ["needs", "needs-project"],
    ],
  );
  const failed = boardItem(task({ state: "failed", error: "No role has a model." }), undefined, null, 0);
  assert.deepEqual([failed.column, failed.kind, failed.detail], ["needs", "failed", "No role has a model."]);
});

test("a started task follows its Chat: running, needing you, in review, then done", () => {
  assert.equal(boardItem(task(), undefined, null, 0).kind, "loading");
  const away = boardItem(task({ computer: "Studio", remoteComputerId: "c2", remoteTaskId: "r1" }), undefined, null, 0);
  assert.deepEqual([away.column, away.kind, away.detail], ["running", "remote", "Running on Studio"]);
  const working = boardItem(task(), { chat: chat(), run: run() }, null, 0);
  assert.deepEqual([working.column, working.mark, working.detail], ["running", "running", "Editing RestTimer.swift"]);
  const asking = boardItem(task(), { chat: chat(), run: run({ approvals: [{ title: "npm test" } as never] }) }, null, 0);
  assert.deepEqual([asking.column, asking.mark, asking.detail], ["needs", "waiting", "Asks to run: npm test"]);
  assert.equal(boardItem(task({ outcome: "merged" }), { chat: chat() }, "open", 0).column, "review");
  assert.equal(boardItem(task(), { chat: chat() }, "merged", 0).column, "done");
  const failing = {
    number: 7,
    title: "Fix",
    url: "https://github.com/o/r/pull/7",
    state: "OPEN",
    checks: "failed",
    readyToMerge: false,
    hasConflicts: false,
  } as const;
  assert.deepEqual(boardItem(task(), { chat: chat() }, "open", 0, failing).pr?.checks, "failed");
  assert.equal(boardItem(task(), { chat: chat({ done_at: 5 }) }, null, 0).column, "done");
  assert.equal(boardItem(task(), { chat: chat({ orchestrator: { taskId: "t1", hidden: false } }) }, null, 0).inSidebar, true);
});

test("columns count every card and list the newest first", () => {
  const items = [
    boardItem(task({ id: "a", createdAt: 1 }), { chat: chat(), run: run() }, null, 0),
    boardItem(task({ id: "b", createdAt: 3, state: "routing" }), undefined, null, 0),
    boardItem(task({ id: "c", createdAt: 2, state: "failed" }), undefined, null, 0),
  ];
  assert.deepEqual(boardCounts(items), { running: 2, needs: 1, review: 0, done: 0 });
  assert.deepEqual(
    columnItems(items, "running").map((item) => item.task.id),
    ["b", "a"],
  );
});

test("labels read as on the desktop", () => {
  assert.equal(modelAndEffort("claude", "claude-opus-5-5", "high"), "Opus 5.5 · High");
  assert.equal(modelAndEffort("claude", "made-up", null), "made-up");
  assert.equal(projectName("/code/gym", []), "gym");
  assert.equal(projectName("/code/gym", [{ path: "/code/gym", name: "happiergym" }]), "happiergym");
  assert.equal(relativeAge(0, 125 * 60000), "2h");
});

test("completed replies require the recorded outcome on the phone", () => {
  const finished = { chat: chat({ summary: { count: 2, lastOutcome: "completed" } as AgentSession["summary"] }) };
  const missing = boardItem(task(), finished, null, 0);
  assert.equal(missing.column, "needs");
  assert.match(missing.detail, /no PR verified/);
  assert.equal(boardItem(task(), finished, "open", 0).column, "done");
  assert.equal(boardItem(task(), finished, "closed", 0).column, "needs");
  assert.equal(boardItem(task({ outcome: "reply" }), finished, null, 0).column, "done");
  const accepted = boardItem(task(), { chat: chat({ done_at: 1, summary: finished.chat.summary }) }, null, 0);
  assert.equal(accepted.column, "done", "marking the Chat Done accepts it without a PR");
  assert.doesNotMatch(accepted.detail, /no PR verified/);
  assert.equal(boardItem(task({ outcome: "merged" }), finished, "open", 0).detail, "Waiting for the PR to merge.");
  assert.equal(boardItem(task(), { ...finished, run: run() }, "merged", 0).column, "running");
  assert.equal(boardItem(task(), { chat: chat() }, null, 0).column, "running");
});

test("a finished task is Done; one its agent marked blocked or that asks a question waits in Needs you with why", () => {
  const summary = { count: 2, lastOutcome: "completed" } as AgentSession["summary"];
  const reason = "Sign in to the resend MCP server with /mcp, then reply continue.";
  const blocked = chat({ summary, orchestrator: { taskId: "t1", hidden: true, blocked: { reason, at: 1 } } });
  assert.equal(boardItem(task({ outcome: "reply" }), { chat: chat({ summary }) }, null, 0).column, "done");
  const waiting = boardItem(task({ outcome: "reply" }), { chat: blocked }, null, 0);
  assert.deepEqual([waiting.column, waiting.detail], ["needs", `Blocked: ${reason}`]);
  const question = { requestId: "q", questions: [{ id: "0", header: "", question: "Which sender domain?", options: [], multiSelect: false }] };
  const asking = boardItem(task({ outcome: "reply" }), { chat: chat(), run: run({ questions: [question] as never }) }, null, 0);
  assert.deepEqual([asking.column, asking.mark, asking.detail], ["needs", "question", "Asks: Which sender domain?"]);
  assert.equal(boardItem(task({ outcome: "reply" }), { chat: blocked, run: run() }, null, 0).column, "running", "a new turn in a blocked task runs");
  assert.equal(boardItem(task({ outcome: "reply" }), { chat: { ...blocked, done_at: 5 } }, null, 0).column, "done", "marking the Chat Done accepts it");
});
