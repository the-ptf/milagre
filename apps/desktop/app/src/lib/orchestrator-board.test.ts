import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { boardCards, boardCounts, caretLook, cardsIn, routeReason, sinceLabel, taskChatKey, taskForChat, taskProjectPaths } from "./orchestrator-board.ts";

const NOW = 1_800_000_000_000;

function task(id: string, patch: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id,
    prompt: `do ${id}`,
    title: `Task ${id}`,
    projectPath: "/p/app",
    worktreeId: "1",
    sessionId: Number(id.replace(/\D/g, "")) || 1,
    computer: null,
    remoteComputerId: null,
    remoteTaskId: null,
    role: "build",
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    accountId: null,
    reason: { project: null, role: null, account: null, computer: null },
    state: "started",
    error: null,
    createdAt: NOW,
    answered: [],
    ...patch,
  };
}

const run = (patch: object = {}) => ({ text: "", model: "m", steps: [], approvals: [], questions: [], answered: {}, ...patch });

test("tasks still routing, without a Project or failed get their own cards before any Chat exists", () => {
  const cards = boardCards(
    [
      task("t1", { state: "routing", projectPath: null, sessionId: null }),
      task("t2", { state: "needs-project", projectPath: null, sessionId: null, createdAt: NOW - 1 }),
      task("t3", { state: "failed", error: "No role has a model", createdAt: NOW - 2 }),
    ],
    {},
    {},
    NOW,
  );
  assert.deepEqual(
    cards.map((card) => [card.task.id, card.kind, card.column, card.key]),
    [
      ["t1", "deciding", "running", null],
      ["t2", "pick-project", "needs", null],
      ["t3", "failed", "needs", null],
    ],
  );
  assert.equal(cards[2]!.detail, "No role has a model");
});

test("a started task's column follows its Chat: running, waiting on the user, a PR, Done", () => {
  const states = {
    "/p/app": {
      sessions: {
        1: { id: 1, orchestrator: { taskId: "t1", hidden: true } },
        2: { id: 2, orchestrator: { taskId: "t2", hidden: false } },
        3: { id: 3, summary: { pullRequests: ["https://github.com/o/r/pull/9"] } },
        4: { id: 4, done_at: NOW - 10, summary: { pullRequests: ["https://github.com/o/r/pull/9"] } },
      },
    },
  };
  const runs = {
    "/p/app#1": run({ text: "Reading the Project\nBuilding for the simulator" }),
    "/p/app#2": run({ approvals: [{ requestId: "a", title: "npm audit --json" }] }),
  } as unknown as AgentRuns;
  const cards = boardCards(
    ["t1", "t2", "t3", "t4"].map((id, index) => task(id, { createdAt: NOW - index })),
    states,
    runs,
    NOW,
  );
  assert.deepEqual(
    cards.map((card) => [card.task.id, card.column, card.state]),
    [
      ["t1", "running", "working"],
      ["t2", "needs", "needs-you"],
      ["t3", "review", "done"],
      ["t4", "done", "done"],
    ],
  );
  assert.equal(cards[0]!.detail, "Building for the simulator");
  assert.equal(cards[1]!.detail, "Asks to run: npm audit --json");
  assert.deepEqual(
    cards.map((card) => card.inSidebar),
    [false, true, true, true],
  );
  assert.deepEqual(boardCounts(cards), { running: 1, needs: 1 });
});

test("the sidebar counts a task as running only while it routes or its turn runs", () => {
  const cards = boardCards(
    [task("t1", { state: "routing", projectPath: null, sessionId: null }), task("t2"), task("t3")],
    { "/p/app": { sessions: { 2: { id: 2 }, 3: { id: 3, summary: { lastOutcome: "failed" } } } } },
    { "/p/app#2": run() } as unknown as AgentRuns,
    NOW,
  );
  assert.deepEqual(boardCounts(cards), { running: 2, needs: 0 });
  assert.equal(cards.find((card) => card.task.id === "t3")?.state, "failed");
});

test("an answered approval no longer counts as needing the user", () => {
  const runs = { "/p/app#1": run({ approvals: [{ requestId: "a", title: "ls" }], answered: { a: { allow: true } } }) } as unknown as AgentRuns;
  assert.equal(boardCards([task("t1")], { "/p/app": { sessions: { 1: { id: 1 } } } }, runs, NOW)[0]!.column, "running");
});

test("cards are newest first and filter by Project", () => {
  const cards = boardCards(
    [task("t1", { createdAt: NOW - 5 }), task("t2", { createdAt: NOW, projectPath: "/p/site" }), task("t3", { createdAt: NOW - 1 })],
    {},
    {},
    NOW,
  );
  assert.deepEqual(
    cards.map((card) => card.task.id),
    ["t2", "t3", "t1"],
  );
  assert.deepEqual(
    cardsIn(cards, "running", "/p/app").map((card) => card.task.id),
    ["t3", "t1"],
  );
});

test("a task's Chat key, the task of a Chat and the Projects tasks run in", () => {
  const tasks = [task("t7", { projectPath: "/p/b" }), task("t8", { projectPath: null, sessionId: null }), task("t9", { projectPath: "/p/a" })];
  assert.equal(taskChatKey(tasks[0]!), "/p/b#7");
  assert.equal(taskChatKey(tasks[1]!), null);
  assert.equal(taskForChat(tasks, "/p/a#9")?.id, "t9");
  assert.equal(taskForChat(tasks, null), null);
  assert.deepEqual(taskProjectPaths(tasks), ["/p/a", "/p/b"]);
});

test("a task placed on a paired computer reads its Chat under that computer's key", () => {
  const remote = task("t4", { projectPath: "/r/app", remoteComputerId: "studio", remoteTaskId: "x", computer: "Studio" });
  assert.equal(taskChatKey(remote), "studio|/r/app#4");
  assert.deepEqual(taskProjectPaths([remote]), ["studio|/r/app"]);
  const states = { "studio|/r/app": { sessions: { 4: { id: 4, done_at: NOW } } } };
  assert.equal(boardCards([remote], states, {}, NOW)[0]!.column, "done");
});

test("ages read as now, minutes, hours and days", () => {
  assert.deepEqual(
    [0, 59_000, 6 * 60_000, 3 * 3_600_000, 50 * 3_600_000].map((ago) => sinceLabel(NOW - ago, NOW)),
    ["now", "now", "6m", "3h", "2d"],
  );
});

test("the mascot looks along the line toward the caret and lower with each line", () => {
  assert.deepEqual(caretLook("", 8, 400), { x: -0.15, y: 0.75 });
  assert.deepEqual(caretLook("x".repeat(50), 8, 400), { x: 1.05, y: 0.75 });
  assert.equal(caretLook("a\nb\nc", 8, 400).y, 0.99);
  assert.equal(caretLook("a\nb\nc\nd\ne", 8, 400).y, 1);
});

test("the route's reason reads as sentences and names where it runs", () => {
  const reason = { project: "Matched “gym” in its hints.", role: "“fix” → Build", account: "Least used today, 22%", computer: null };
  assert.equal(
    routeReason({ reason, computer: null }, "this computer"),
    "Matched “gym” in its hints. “fix” → Build. Least used today, 22%. Runs on this computer.",
  );
  assert.equal(
    routeReason({ reason: { ...reason, role: null }, computer: "Studio" }, "this computer"),
    "Matched “gym” in its hints. Least used today, 22%. Runs on Studio.",
  );
});
