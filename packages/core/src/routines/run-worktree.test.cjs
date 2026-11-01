const assert = require("node:assert/strict");
const test = require("node:test");
const { retireRunWorktree } = require("./run-worktree.cjs");

const PROJECT = "/code/app";
const RUN_CHAT = `${PROJECT}#4`;

// A Project with its folder (1) and a Run's Worktree (7) holding the Run's Chat (4) and an empty one (5).
function project(over = {}) {
  return {
    worktrees: {
      1: { id: 1, path: PROJECT, name: "main" },
      7: { id: 7, path: "/worktrees/chat-ab12", name: "chat-ab12", base: "origin/main" },
    },
    sessions: {
      3: { id: 3, worktree_id: 1, summary: { count: 2 } },
      4: { id: 4, worktree_id: 7, summary: { count: 3 }, routine: { routineId: "r1", runId: "run1", hidden: true } },
      5: { id: 5, worktree_id: 7 },
    },
    messages: [],
    ...over,
  };
}

function harness({
  state = project(),
  status = { removable: true, uncommitted: 0, unpushed: 0, branch: "milagre/chat-ab12" },
  hasRemote = false,
  pr = { known: true, open: false },
  removeError,
  busy = [],
} = {}) {
  const calls = { closed: [], moves: [], removed: [], prChecks: 0 };
  const deps = {
    projectPath: PROJECT,
    worktreeId: 7,
    chatIds: [RUN_CHAT],
    state: async () => state,
    busy: (chatKey) => busy.includes(chatKey),
    status: async () => status,
    hasRemote: async () => hasRemote,
    openPullRequest: async () => {
      calls.prChecks += 1;
      return pr;
    },
    closeChat: async (chatKey) => calls.closed.push(chatKey),
    moveChats: async (projectPath, ids, change) => {
      calls.moves.push({ projectPath, ids, change });
      return change.restore ? {} : { 4: { worktree_id: 7, archived: undefined }, 5: { worktree_id: 7, archived: undefined } };
    },
    remove: async (worktree) => {
      if (removeError) throw removeError;
      calls.removed.push(worktree.path);
    },
  };
  return { calls, run: () => retireRunWorktree(deps) };
}

test("a Run's clean Worktree goes, after its Chat is closed and moved, archived, to the Project folder", async () => {
  const { calls, run } = harness();
  assert.deepEqual(await run(), { removed: true });
  assert.deepEqual(calls.closed, [RUN_CHAT]);
  assert.deepEqual(calls.moves, [
    {
      projectPath: PROJECT,
      ids: [4],
      change: { worktreeId: 1, formerWorktree: { path: "/worktrees/chat-ab12", name: "chat-ab12", branch: "milagre/chat-ab12" }, archive: [5] },
    },
  ]);
  assert.deepEqual(calls.removed, ["/worktrees/chat-ab12"]);
  assert.equal(calls.prChecks, 0);
});

test("a Worktree with changes, commits nowhere else, or an open PR is kept, and nothing is touched", async () => {
  const cases = [
    [{ status: { removable: false, uncommitted: 2, unpushed: 0, branch: "b" } }, "it has uncommitted changes"],
    [{ status: { removable: false, uncommitted: 0, unpushed: 1, branch: "b" } }, "it has commits on neither its base nor its upstream"],
    [{ status: null }, "it has commits on neither its base nor its upstream"],
    [{ hasRemote: true, pr: { known: true, open: true } }, "its branch has an open pull request"],
    [{ hasRemote: true, pr: { known: false, open: false } }, "its pull requests couldn't be checked"],
  ];
  for (const [over, reason] of cases) {
    const { calls, run } = harness(over);
    assert.deepEqual(await run(), { removed: false, reason }, reason);
    assert.deepEqual([calls.closed, calls.moves, calls.removed], [[], [], []], reason);
  }
});

test("a branch with a remote is checked for PRs even without a tracking upstream", async () => {
  const { calls, run } = harness({ hasRemote: true, pr: { known: true, open: false } });
  assert.deepEqual(await run(), { removed: true });
  assert.equal(calls.prChecks, 1);
});

test("a running Chat, a kept Run Chat or another Chat in use keeps the Worktree", async () => {
  const kept = project();
  kept.sessions[4].routine.hidden = false;
  const other = project();
  other.sessions[6] = { id: 6, worktree_id: 7, summary: { count: 1 } };
  const archivedOther = project();
  archivedOther.sessions[6] = { id: 6, worktree_id: 7, summary: { count: 1 }, archived: true };
  assert.deepEqual(await harness({ busy: [RUN_CHAT] }).run(), { removed: false, reason: "a Chat there is running" });
  assert.deepEqual(await harness({ state: kept }).run(), { removed: false, reason: "the Run's Chat was kept" });
  assert.deepEqual(await harness({ state: other }).run(), { removed: false, reason: "another Chat uses the Worktree" });
  // An archived Chat with messages there leaves with the Worktree, kept like the Run's.
  const archived = harness({ state: archivedOther });
  assert.deepEqual(await archived.run(), { removed: true });
  assert.deepEqual(archived.calls.moves[0].ids, [4, 6]);
});

test("only a Worktree Milagre made for the Run goes", async () => {
  const noBase = project();
  delete noBase.worktrees[7].base;
  const shared = project();
  shared.worktrees[7].sharedChat = "link#1";
  const folder = project();
  folder.worktrees[7].path = PROJECT;
  for (const state of [noBase, shared, folder])
    assert.deepEqual(await harness({ state }).run(), { removed: false, reason: "Milagre didn't make this Worktree for the Run" });
  assert.deepEqual(await harness({ state: project({ worktrees: {} }) }).run(), { removed: false, reason: "the Worktree is gone" });
});

test("a removal that fails moves the Chats back as they were and keeps the Worktree", async () => {
  const { calls, run } = harness({ removeError: new Error("Worktree changed after it was checked") });
  assert.deepEqual(await run(), { removed: false, reason: "Worktree changed after it was checked" });
  assert.equal(calls.moves.length, 2);
  assert.deepEqual(calls.moves[1].change, { restore: { 4: { worktree_id: 7, archived: undefined }, 5: { worktree_id: 7, archived: undefined } } });
  assert.deepEqual(calls.moves[1].ids, [4, 5]);
});
