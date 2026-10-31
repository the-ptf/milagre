import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, CoordinatorState } from "./model.ts";
import { patchSession, renameWorktree, withDiffStats } from "./project-edits.mjs";

const state = (): CoordinatorState => ({
  next_id: 4,
  projects: {},
  worktrees: {
    "1": { id: 1, project_id: 1, path: "/work/app", name: "main" },
    "2": { id: 2, project_id: 1, path: "/work/wt", name: "milagre/fix-the-thing-ab12" },
  },
  sessions: {
    "1": { id: 1, worktree_id: 1, agent_name: "main", status: "Created" },
    "2": { id: 2, worktree_id: 2, agent_name: "milagre/fix-the-thing-ab12", status: "Created" },
    "3": { id: 3, worktree_id: 2, agent_name: "Reviewer", status: "Created" },
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

const rename = { projectPath: "/work/app", path: "/work/wt", from: "milagre/fix-the-thing-ab12", name: "milagre/login-redirect-ab12" };

test("renameWorktree renames the worktree and the chats named after its branch", () => {
  const next = renameWorktree(state(), rename);
  assert.equal(next.worktrees[2].name, "milagre/login-redirect-ab12");
  assert.equal(next.sessions[2].agent_name, "milagre/login-redirect-ab12");
  assert.equal(next.sessions[3].agent_name, "Reviewer");
  assert.deepEqual(next.worktrees[1], state().worktrees[1]);
  assert.deepEqual(next.sessions[1], state().sessions[1]);
});

test("renameWorktree leaves the state alone when the worktree moved on", () => {
  const before = state();
  assert.equal(renameWorktree(before, { ...rename, path: "/work/other" }), before);
  assert.equal(renameWorktree(before, { ...rename, from: "milagre/something-else" }), before);
});

// One chat, and a worktree with a diff stat already saved.
const session: AgentSession = { id: 1, worktree_id: 1, agent_name: "main", status: "Created" };

const chatState = (): CoordinatorState => ({
  next_id: 3,
  projects: {},
  worktrees: {
    "1": { id: 1, project_id: 1, path: "/work/app", name: "main" },
    "2": { id: 2, project_id: 1, path: "/work/wt", name: "milagre/x", diff: { added: 3, removed: 1 } },
  },
  sessions: { "1": session },
  connections: {},
  events: [],
  messages: [],
  approvals: [],
  tasks: {},
  artifacts: {},
  outputs: [],
  conflicts: [],
});

test("patchSession sets and clears fields, and keeps an unchanged state", () => {
  const initial = chatState();
  const renamed = patchSession(initial, 1, { title: "Login", unread: true });
  assert.deepEqual(renamed.sessions[1], { ...session, title: "Login", unread: true });
  const cleared = patchSession(renamed, 1, { title: "", unread: false });
  assert.deepEqual(cleared.sessions[1], session);
  assert.equal(patchSession(initial, 1, { unread: false }), initial);
  assert.equal(patchSession(initial, 99, { archived: true }), initial);
});

test("patchSession pins with an order, unpins, and ignores an order that isn't a number", () => {
  const pinned = patchSession(chatState(), 1, { pinned: true, pin_order: 0 });
  assert.deepEqual(pinned.sessions[1], { ...session, pinned: true, pin_order: 0 });
  assert.equal(patchSession(pinned, 1, { pin_order: Number.NaN }), pinned);
  assert.equal(patchSession(pinned, 1, { pin_order: "2" as never }), pinned);
  assert.deepEqual(patchSession(pinned, 1, { pinned: false, pin_order: undefined }).sessions[1], session);
});

test("patchSession stores a Done time, clears it, and ignores one that isn't a number", () => {
  const done = patchSession(chatState(), 1, { done_at: 1234 });
  assert.deepEqual(done.sessions[1], { ...session, done_at: 1234 });
  assert.equal(patchSession(done, 1, { done_at: "soon" as never }), done);
  assert.deepEqual(patchSession(done, 1, { done_at: undefined }).sessions[1], session);
  // `done` is the client's ask: only the host turns it into a time.
  assert.equal(patchSession(chatState(), 1, { done: true }).sessions[1], session);
});

test("withDiffStats stores new stats and skips missing or unchanged ones", () => {
  const initial = chatState();
  assert.equal(withDiffStats(initial, { 2: { added: 3, removed: 1 }, 1: null, 9: { added: 1, removed: 1 } }), initial);
  const next = withDiffStats(initial, { 1: { added: 10, removed: 2 } });
  assert.deepEqual(next.worktrees[1].diff, { added: 10, removed: 2 });
  assert.equal(next.worktrees[2], initial.worktrees[2]);
});

test("a batch of diff stats preserves the old snapshot and unchanged worktrees", () => {
  const initial = state();
  initial.worktrees[3] = { id: 3, project_id: 1, path: "/work/untouched", name: "untouched" };
  const before = structuredClone(initial);
  const stats = { 1: { added: 10, removed: 2 }, 2: { added: 4, removed: 3 } };
  const next = withDiffStats(initial, stats);
  assert.deepEqual(initial, before);
  assert.notEqual(next.worktrees, initial.worktrees);
  assert.deepEqual(next.worktrees[1].diff, stats[1]);
  assert.deepEqual(next.worktrees[2].diff, stats[2]);
  assert.equal(next.worktrees[3], initial.worktrees[3]);
  assert.equal(withDiffStats(next, stats), next);
});
