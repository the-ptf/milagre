import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import {
  boardCards,
  boardCounts,
  caretPoint,
  cardsIn,
  gazeToward,
  routeReason,
  sinceLabel,
  taskChatKey,
  taskForChat,
  taskProjectPaths,
} from "./orchestrator-board.ts";

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
    permissionMode: "auto",
    answered: [],
    images: 0,
    limit: null,
    outcome: "pull-request",
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
        5: { id: 5, summary: { lastOutcome: "completed" } },
      },
    },
  };
  const runs = {
    "/p/app#1": run({ text: "Reading the Project\nBuilding for the simulator" }),
    "/p/app#2": run({ approvals: [{ requestId: "a", title: "npm audit --json" }] }),
  } as unknown as AgentRuns;
  const cards = boardCards(
    ["t1", "t2", "t3", "t4", "t5"].map((id, index) => task(id, { createdAt: NOW - index })),
    states,
    runs,
    NOW,
  );
  assert.deepEqual(
    cards.map((card) => [card.task.id, card.column, card.state]),
    [
      ["t1", "running", "working"],
      ["t2", "needs", "needs-you"],
      ["t3", "done", "done"],
      ["t4", "done", "done"],
      ["t5", "needs", "done"],
    ],
  );
  assert.equal(cards[0]!.detail, "Building for the simulator");
  assert.equal(cards[1]!.detail, "Asks to run: npm audit --json");
  assert.deepEqual(
    cards.map((card) => card.inSidebar),
    [false, true, true, true, true],
  );
  assert.deepEqual(boardCounts(cards), { running: 1, needs: 2 });
});

test("the sidebar counts a task as running only while it routes or its turn runs; a failed one needs the user", () => {
  const cards = boardCards(
    [task("t1", { state: "routing", projectPath: null, sessionId: null }), task("t2"), task("t3")],
    { "/p/app": { sessions: { 2: { id: 2 }, 3: { id: 3, summary: { lastOutcome: "failed" } } } } },
    { "/p/app#2": run() } as unknown as AgentRuns,
    NOW,
  );
  assert.deepEqual(boardCounts(cards), { running: 2, needs: 1 });
  assert.equal(cards.find((card) => card.task.id === "t3")?.state, "failed");
});

test("a task whose turn ended without a PR needs the owner", () => {
  const states = { "/p/app": { sessions: { 1: { id: 1, summary: { count: 2 } } } } };
  assert.equal(boardCards([task("t1")], states as never, {}, NOW)[0]!.column, "needs");
});

test("a task the owner moved stays in that column", () => {
  const states = { "/p/app": { sessions: { 1: { id: 1, summary: { count: 2 }, orchestrator: { taskId: "t1", hidden: true, column: "review" } } } } };
  assert.equal(boardCards([task("t1")], states as never, {}, NOW)[0]!.column, "review");
});

test("a finished task is Done; one its agent marked blocked or that asks a question waits in Needs you with why", () => {
  const blocked = { reason: "Sign in to the resend MCP server with /mcp, then reply continue.", at: NOW - 5 };
  const states = {
    "/p/app": {
      sessions: {
        1: { id: 1, summary: { lastOutcome: "completed", count: 2 } },
        2: { id: 2, summary: { lastOutcome: "completed", count: 2 }, orchestrator: { taskId: "t2", hidden: true, blocked } },
        3: { id: 3 },
      },
    },
  };
  const question = { requestId: "q", questions: [{ id: "0", header: "", question: "Which sender domain?", options: [], multiSelect: false }] };
  const runs = { "/p/app#3": run({ questions: [question] }) } as unknown as AgentRuns;
  const cards = boardCards(
    ["t1", "t2", "t3"].map((id, index) => task(id, { outcome: "reply", createdAt: NOW - index })),
    states,
    runs,
    NOW,
  );
  assert.deepEqual(
    cards.map((card) => [card.task.id, card.column, card.state, card.detail]),
    [
      ["t1", "done", "done", "Finished"],
      ["t2", "needs", "needs-you", "Blocked: Sign in to the resend MCP server with /mcp, then reply continue."],
      ["t3", "needs", "needs-you", "Asks: Which sender domain?"],
    ],
  );
  assert.deepEqual(boardCounts(cards), { running: 0, needs: 2 });
  const running = boardCards([task("t2", { outcome: "reply" })], states, { "/p/app#2": run() } as unknown as AgentRuns, NOW)[0]!;
  assert.equal(running.column, "running", "a new turn in a blocked task runs");
  const done = { "/p/app": { sessions: { 2: { ...states["/p/app"].sessions[2], done_at: NOW } } } };
  assert.equal(boardCards([task("t2", { outcome: "reply" })], done, {}, NOW)[0]!.column, "done", "marking the Chat Done accepts it");
});

test("a task at its usage limit waits in Needs you and says until when", () => {
  const limited = task("t1", { limit: { provider: "claude", resetsAt: new Date(NOW + 3_600_000).toISOString() } });
  const [card] = boardCards([limited], { "/p/app": { sessions: { 1: { id: 1, summary: { lastOutcome: "failed" } } } } }, {}, NOW);
  assert.equal(card!.column, "needs");
  assert.match(card!.detail, /^Claude hit its usage limit\. It resets at /);
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
  const remote = task("t4", { projectPath: "/r/app", remoteComputerId: "studio", remoteTaskId: "x", computer: "Studio", outcome: "reply" });
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

test("the caret's place on screen follows its column and line", () => {
  const field = { left: 100, top: 50, width: 400, padLeft: 4, padTop: 6, lineHeight: 20 };
  assert.deepEqual(caretPoint("", 8, field), { x: 104, y: 66 });
  assert.deepEqual(caretPoint("abcde", 8, field), { x: 144, y: 66 });
  assert.deepEqual(caretPoint("a\nb\ncd", 8, field), { x: 120, y: 106 });
  assert.equal(caretPoint("x".repeat(500), 8, field).x, 504, "a long line stays inside the field");
});

test("the mascot looks straight at a point at full strength", () => {
  const bot = { left: 0, top: 0, width: 40, height: 40 };
  assert.deepEqual(gazeToward(bot, { x: 220, y: 20 }), { x: 1, y: 0 });
  assert.deepEqual(gazeToward(bot, { x: 20, y: 120 }), { x: 0, y: 1 });
  assert.deepEqual(gazeToward(bot, { x: 20, y: 20 }), { x: 0, y: 0 });
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

test("a request autopilot is about to answer keeps the card running", () => {
  const states = { "/p/app": { sessions: { 1: { id: 1 } } } };
  const runs = { "/p/app#1": run({ approvals: [{ requestId: "a", title: "Use Read?" }] }) } as unknown as AgentRuns;
  const waiting = task("t1", {
    answered: [{ at: NOW, kind: "approval:read", requestId: "a", decision: "vetoed", summary: "allowed Use Read?", until: NOW + 30_000 }],
  });
  const card = boardCards([waiting], states, runs, NOW)[0]!;
  assert.equal(card.column, "running");
  assert.equal(card.detail, "Answering for you in 30 s unless you answer first: allowed Use Read?");
  assert.equal(boardCards([waiting], states, runs, NOW + 31_000)[0]!.column, "needs");
});

const PR_URL = "https://github.com/acme/app/pull/7";
const withPr = {
  "/p/app": {
    sessions: { 1: { id: 1, worktree_id: 4, summary: { lastOutcome: "completed", count: 2, pullRequests: [PR_URL] } } },
    worktrees: { 4: { path: "/w/four" } },
  },
};
const prSnapshot = (state: string) => ({ "/p/app": { worktrees: {}, chats: { "/w/four": { [PR_URL]: { number: 7, url: PR_URL, state } } }, pending: false } });

test("the board uses verified PR state and explains unmet outcomes", () => {
  const states = { "/p/app": { sessions: { 1: { id: 1, summary: { lastOutcome: "completed" } } } } };
  const missing = boardCards([task("t1")], states, {}, NOW)[0]!;
  assert.equal(missing.column, "needs");
  assert.match(missing.detail, /no PR verified/);
  const waiting = boardCards([task("t1", { outcome: "merged" })], withPr as never, {}, NOW, prSnapshot("OPEN") as never)[0]!;
  assert.equal(waiting.column, "review");
  assert.equal(waiting.detail, "Waiting for the PR to merge.");
  assert.equal(boardCards([task("t1", { outcome: "reply" })], states, {}, NOW)[0]!.column, "done");
  const marked = { "/p/app": { sessions: { 1: { id: 1, done_at: NOW - 10, summary: { lastOutcome: "completed" } } } } };
  const accepted = boardCards([task("t1")], marked, {}, NOW)[0]!;
  assert.equal(accepted.column, "done", "marking the Chat Done accepts it without a PR");
  assert.doesNotMatch(accepted.detail, /no PR verified/);
  assert.equal(boardCards([task("t1")], withPr as never, { "/p/app#1": run() } as AgentRuns, NOW, prSnapshot("OPEN") as never)[0]!.column, "running");
});

test("a task's PR reads from its Project's snapshot and meets the recorded outcome", () => {
  const card = (outcome: string, snapshots?: object) => boardCards([task("t1", { outcome } as never)], withPr as never, {}, NOW, snapshots as never)[0]!;
  assert.deepEqual([card("pull-request").column, card("pull-request").pullRequest], ["done", "open"], "unread yet: counts as open");
  assert.deepEqual([card("merged", prSnapshot("OPEN")).column, card("merged", prSnapshot("OPEN")).pullRequest], ["review", "open"]);
  assert.deepEqual([card("merged", prSnapshot("MERGED")).column, card("merged", prSnapshot("MERGED")).pullRequest], ["done", "merged"]);
  assert.deepEqual([card("pull-request", prSnapshot("CLOSED")).column, card("pull-request", prSnapshot("CLOSED")).pullRequest], ["needs", "closed"]);
});
