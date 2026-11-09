const assert = require("node:assert/strict");
const test = require("node:test");
const { emptyState, reconcileState } = require("./project-state.cjs");

const main = { path: "/repo/shop", name: "main" };
const feature = { path: "/home/.milagre/worktrees/shop/cart-ab12", name: "milagre/cart-ab12" };

test("Windows worktree reconciliation preserves saved Chats across Git and native separators", () => {
  for (const [saved, listed] of [
    ["C:\\Users\\me\\shop", "C:/Users/me/shop"],
    ["C:/Users/me/shop", "C:\\Users\\me\\shop"],
  ]) {
    const stored = {
      ...emptyState("shop"),
      next_id: 4,
      worktrees: { 1: { id: 1, project_id: 1, path: saved, name: "main" } },
      sessions: { 2: { id: 2, worktree_id: 1, title: "Saved chat", agent_name: "main", native_session_id: "existing-provider-session" } },
      messages: [{ id: 3, session_id: 2, body: "Saved conversation" }],
    };
    const state = reconcileState(stored, "shop", [{ path: listed, name: "main" }], { platform: "win32" });
    assert.deepEqual(state.sessions, stored.sessions);
    assert.deepEqual(state.messages, stored.messages);
    assert.equal(state.worktrees[1].path, "C:\\Users\\me\\shop");
    assert.equal(state.next_id, 4);
    assert.equal(stored.worktrees[1].path, saved);
    assert.equal(reconcileState(state, "shop", [{ path: listed, name: "main" }], { platform: "win32" }), state);
  }
});

test("Windows reconciliation resolves filesystem aliases without guessing case equivalence", () => {
  const stored = {
    ...emptyState("shop"),
    next_id: 4,
    worktrees: { 1: { id: 1, project_id: 1, path: "c:/users/me/shop", name: "main" } },
    sessions: { 2: { id: 2, worktree_id: 1, title: "Saved chat", agent_name: "main", native_session_id: "provider-session" } },
    messages: [{ id: 3, session_id: 2, body: "Existing conversation" }],
  };
  const canonical = "C:\\Users\\Me\\Shop";
  const state = reconcileState(stored, "shop", [{ path: canonical, name: "main" }], { platform: "win32", realpathSync: () => canonical });
  assert.deepEqual(state.sessions, stored.sessions);
  assert.deepEqual(state.messages, stored.messages);
  assert.equal(state.worktrees[1].path, canonical);
  assert.equal(state.next_id, 4);
});

test("a new worktree gets one empty chat", () => {
  const state = reconcileState(null, "shop", [main]);
  const sessions = Object.values(state.sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].worktree_id, Object.values(state.worktrees)[0].id);
  assert.equal(sessions[0].agent_name, "main");
});

test("every chat of a worktree survives a reload with its messages", () => {
  const stored = {
    ...emptyState("shop"),
    next_id: 10,
    worktrees: { 1: { id: 1, project_id: 1, path: main.path, name: "main" } },
    sessions: {
      2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created" },
      5: { id: 5, worktree_id: 1, agent_name: "main", status: "Created" },
    },
    messages: [
      { id: 3, session_id: 2, body: "first chat", context: null },
      { id: 6, session_id: 5, body: "second chat", context: null },
    ],
  };
  const state = reconcileState(stored, "shop", [main]);
  assert.deepEqual(Object.keys(state.sessions).sort(), ["2", "5"]);
  assert.deepEqual(
    state.messages.map((message) => message.body),
    ["first chat", "second chat"],
  );
  assert.equal(state.next_id, 10);
});

test("chats of a removed worktree are dropped and new worktrees get fresh ids", () => {
  const stored = {
    ...emptyState("shop"),
    next_id: 4,
    worktrees: { 1: { id: 1, project_id: 1, path: "/gone", name: "old" } },
    sessions: { 2: { id: 2, worktree_id: 1, agent_name: "old", status: "Created" } },
    messages: [{ id: 3, session_id: 2, body: "stale", context: null }],
  };
  const state = reconcileState(stored, "shop", [main, feature]);
  assert.deepEqual(
    Object.values(state.worktrees).map((worktree) => worktree.name),
    ["main", "milagre/cart-ab12"],
  );
  assert.equal(state.messages.length, 0);
  assert.ok(Object.values(state.sessions).every((session) => session.id >= 4));
  assert.equal(new Set(Object.values(state.sessions).map((session) => session.worktree_id)).size, 2);
});

test("a state that already matches git's worktrees is returned as is", () => {
  const discovered = [{ path: "/repo", name: "main" }];
  const state = reconcileState(null, "repo", discovered);
  assert.equal(reconcileState(state, "repo", discovered), state);
  assert.notEqual(reconcileState(state, "repo", [...discovered, { path: "/repo-wt", name: "feature" }]), state);
});

test("restored children without a live session retain output but do not claim to be running", () => {
  const { markDisconnectedSubagents } = require("./project-state.cjs");
  const state = {
    sessions: {
      1: {
        subagents: [
          { id: "c", status: "running", updatedAt: 10, transcript: [{ text: "partial" }] },
          { id: "d", status: "completed" },
        ],
      },
      2: { subagents: [{ id: "live", status: "running" }] },
    },
  };
  const restored = markDisconnectedSubagents(state, new Set([2]));
  assert.equal(restored.sessions[1].subagents[0].status, "unknown");
  assert.equal(restored.sessions[1].subagents[0].transcript[0].text, "partial");
  assert.equal(restored.sessions[1].subagents[1].status, "completed");
  assert.equal(restored.sessions[2].subagents[0].status, "running");
});

test("a restored Chat with no live agent process has no background task left", () => {
  const { markDisconnectedSubagents } = require("./project-state.cjs");
  const task = { id: "b1", kind: "local_bash", title: "sleep 75", startedAt: 1 };
  const state = { sessions: { 1: { id: 1, backgroundTasks: [task] }, 2: { id: 2, backgroundTasks: [task] } } };
  const restored = markDisconnectedSubagents(state, new Set([2]));
  assert.deepEqual(restored.sessions[1], { id: 1 });
  assert.deepEqual(restored.sessions[2].backgroundTasks, [task]);
});

test("a state with no running subagent to mark is returned as is", () => {
  const { markDisconnectedSubagents } = require("./project-state.cjs");
  const state = { sessions: { 1: { id: 1, subagents: [{ id: "d", status: "completed" }] }, 2: { id: 2 } } };
  assert.equal(markDisconnectedSubagents(state, new Set()), state);
});

test("new Projects omit obsolete spec fields and old Projects retain them on read", () => {
  const { emptyState, reconcileState } = require("./project-state.cjs");
  const fresh = emptyState("Fresh");
  for (const field of ["connections", "events", "approvals", "artifacts", "outputs", "conflicts"]) assert.equal(field in fresh, false, field);
  const old = { ...fresh, outputs: [{ legacy: true }], approvals: ["old"] };
  const loaded = reconcileState(old, "Fresh", []);
  assert.deepEqual(loaded.outputs, old.outputs);
  assert.deepEqual(loaded.approvals, old.approvals);
});
