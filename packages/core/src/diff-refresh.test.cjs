const assert = require("node:assert/strict");
const test = require("node:test");
const { DiffRefresher } = require("./diff-refresh.cjs");
const { ProjectStates } = require("./project-states.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

// Two projects, each with a chat that has a message in worktree 1 and a worktree 2 with no chat.
function projectState(projectPath) {
  return {
    worktrees: { 1: { id: 1, name: "main", path: projectPath, base: "main" }, 2: { id: 2, name: "idle", path: `${projectPath}-idle` } },
    sessions: { 7: { id: 7, worktree_id: 1 } },
    messages: [{ id: 8, session_id: 7, role: "user", body: "hi" }],
  };
}

function harness({ now = () => 0 } = {}) {
  const reads = [];
  const states = new ProjectStates({ read: async (projectPath) => projectState(projectPath), save: async () => {} });
  const diffs = new DiffRefresher({
    states,
    readDiffStat: async (worktreePath, base) => {
      reads.push({ worktreePath, base });
      return { added: reads.length, removed: 0 };
    },
    update: (projectPath, change) => states.update(projectPath, change),
    debounceMs: 10,
    now,
  });
  return { diffs, states, reads };
}

test("a burst of agent steps in a chat re-reads its worktree once, in any project", async () => {
  const { diffs, states, reads } = harness();
  await states.get("/b");
  for (const type of ["step-completed", "step-completed", "turn-completed"]) diffs.observe("/b#7", { type });
  diffs.observe("/b#7", { type: "text-delta", text: "x" });
  await waitUntil(() => reads.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(reads, [{ worktreePath: "/b", base: "main" }]);
  assert.deepEqual((await states.get("/b")).worktrees[1].diff, { added: 1, removed: 0 });
});

test("an event for a project not read this run reads nothing", async () => {
  const { diffs, reads } = harness();
  diffs.observe("/never#7", { type: "turn-completed" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(reads, []);
});

test("refreshing a project reads every worktree that has a chat", async () => {
  const { diffs, reads } = harness();
  await diffs.refresh("/a");
  assert.deepEqual(
    reads.map((read) => read.worktreePath),
    ["/a"],
  );
});

test("focus refreshes only the visible Project, throttled per Project", async () => {
  let clock = 0;
  const { diffs, states, reads } = harness({ now: () => clock });
  await Promise.all([states.get("/a"), states.get("/b")]);
  diffs.focused("/a");
  clock = 4000;
  diffs.focused("/a");
  await waitUntil(() => reads.length === 1);
  diffs.focused("/b");
  await waitUntil(() => reads.length === 2);
  clock = 6000;
  diffs.focused("/a");
  await waitUntil(() => reads.length === 3);

  assert.deepEqual(reads.map((read) => read.worktreePath).sort(), ["/a", "/a", "/b"]);
});

test("a Chat opened reads only its own worktree, throttled per worktree, and a focus read of its Project covers it", async () => {
  let clock = 0;
  const { diffs, states, reads } = harness({ now: () => clock });
  await states.update("/a", (state) => ({ ...state, sessions: { ...state.sessions, 9: { id: 9, worktree_id: 2 } } }));
  diffs.focusedChat("/a#9");
  await waitUntil(() => reads.length === 1);
  assert.deepEqual(reads, [{ worktreePath: "/a-idle", base: undefined }]);
  clock = 4000;
  diffs.focusedChat("/a#9");
  diffs.focusedChat("/a#7");
  await waitUntil(() => reads.length === 2);
  assert.equal(reads[1].worktreePath, "/a");
  clock = 10000;
  diffs.focused("/a");
  await waitUntil(() => reads.length === 3);
  clock = 11000;
  diffs.focusedChat("/a#7");
  diffs.focusedChat("/never#1");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads.length, 3);
  diffs.close();
});

test("thinking completions do not read Git", async () => {
  const { diffs, states, reads } = harness();
  await states.get("/a");
  diffs.observe("/a#7", { type: "step-started", step: { id: "thought", kind: "thinking" } });
  diffs.observe("/a#7", { type: "step-completed", id: "thought" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(reads, []);
  diffs.close();
});

test("concurrent refreshes share four Git slots and close cancels queued reads", async () => {
  const states = new ProjectStates({ read: async (p) => projectState(p), save: async () => {} });
  const releases = [];
  const reads = [];
  let active = 0,
    max = 0,
    updates = 0;
  const diffs = new DiffRefresher({
    states,
    readDiffStat: async (p) => {
      reads.push(p);
      max = Math.max(max, ++active);
      await new Promise((resolve) => releases.push(resolve));
      --active;
      return { added: 1, removed: 0 };
    },
    update: async () => {
      updates++;
    },
  });
  const pending = Array.from({ length: 10 }, (_, i) => diffs.refresh("/" + i));
  await waitUntil(() => reads.length >= 4);
  assert.equal(reads.length, 4);
  assert.equal(max, 4);
  diffs.close();
  releases.forEach((resolve) => resolve());
  await Promise.all(pending);
  assert.equal(reads.length, 4);
  assert.equal(updates, 0);
});

test("only steps that can change files schedule a read", async () => {
  const { diffs, states, reads } = harness();
  await states.get("/a");
  const step = (id, kind) => {
    diffs.observe("/a#7", { type: "step-started", step: { id, kind } });
    diffs.observe("/a#7", { type: "step-completed", id });
  };
  for (const kind of ["read", "search", "thinking", "setup", "image"]) step(`s-${kind}`, kind);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(reads, []);
  const writers = ["edit", "shell", "other"];
  for (const [index, kind] of writers.entries()) {
    step(`f-${kind}`, kind);
    await waitUntil(() => reads.length === index + 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(reads.length, 3);
  diffs.close();
});

test("a step completed without a recorded start still refreshes, and a turn end drops the kinds", async () => {
  const { diffs, states, reads } = harness();
  await states.get("/a");
  diffs.observe("/a#7", { type: "step-started", step: { id: "x", kind: "read" } });
  diffs.observe("/a#7", { type: "turn-completed" });
  assert.equal(diffs.stepKinds.has("/a#7"), false);
  diffs.observe("/a#7", { type: "step-completed", id: "x" });
  await waitUntil(() => reads.length >= 1);
  diffs.close();
});
