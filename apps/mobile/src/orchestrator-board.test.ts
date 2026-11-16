import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRun } from "@milagre/shared/agent-runs";
import type { AgentSession } from "@milagre/shared/model";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { boardCounts, boardItem, columnItems, modelAndEffort, projectName, pullRequestState, relativeAge } from "./orchestrator-board.ts";

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
  answered: [],
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
  assert.equal(boardItem(task(), { chat: chat() }, "open", 0).column, "review");
  assert.equal(boardItem(task(), { chat: chat() }, "merged", 0).column, "done");
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

test("an open PR wins over a merged one; labels read as on the desktop", () => {
  assert.equal(pullRequestState(["MERGED", "OPEN"]), "open");
  assert.equal(pullRequestState(["CLOSED"]), "closed");
  assert.equal(pullRequestState([]), null);
  assert.equal(modelAndEffort("claude", "claude-opus-5-5", "high"), "Opus 5.5 · High");
  assert.equal(modelAndEffort("claude", "made-up", null), "made-up");
  assert.equal(projectName("/code/gym", []), "gym");
  assert.equal(projectName("/code/gym", [{ path: "/code/gym", name: "happiergym" }]), "happiergym");
  assert.equal(relativeAge(0, 125 * 60000), "2h");
});
