import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, ChatMessage, CoordinatorState } from "./model.ts";
import { archiveChat, archiveLinkChat, deleteUndoWindow, undoDelete } from "./archive.mjs";
import type { ArchiveDeps } from "./archive.mjs";
import type { ArchivePlan } from "./archive.mjs";

const session = (id: number, worktree_id: number, extra: Partial<AgentSession> = {}) =>
  ({ id, worktree_id, agent_name: "x", status: "Created", ...extra }) as AgentSession;
const baseState = (): CoordinatorState => ({
  next_id: 10,
  projects: {},
  worktrees: {
    "1": { id: 1, project_id: 1, path: "/work/shop", name: "main" },
    "2": { id: 2, project_id: 1, path: "/tmp/wt/shop/x-1", name: "milagre/x-1", base: "main" },
  },
  sessions: { "1": session(1, 1), "2": session(2, 2) },
  connections: {},
  events: [],
  messages: [{ id: 1, session_id: 2, body: "hi", context: null, role: "user" } as ChatMessage],
  approvals: [],
  tasks: {},
  artifacts: {},
  outputs: [],
  conflicts: [],
});

const status = { uncommitted: 2, unpushed: 0, branch: "milagre/x-1", head: "abc", removable: false };
const plan: ArchivePlan = { milagreOwned: true, shared: false, status };

function harness(overrides: Partial<ArchiveDeps> = {}, state = baseState()) {
  const calls: string[] = [];
  const notices: string[] = [];
  const applied: Array<{ worktreeId: number; sessionIds: number[] }> = [];
  const removals: unknown[] = [];
  let project = "/work/shop";
  const deps: ArchiveDeps = {
    projectPath: "/work/shop",
    chatId: "/work/shop#2",
    getState: () => state,
    currentProjectPath: () => project,
    stop: () => {
      calls.push("stop");
      return undefined;
    },
    hide: () => calls.push("hide"),
    destroy: () => calls.push("destroy"),
    restore: () => calls.push("restore"),
    remove: async (worktree, options) => {
      calls.push("remove");
      removals.push({ path: worktree.path, ...options });
    },
    applyRemoval: (removed) => {
      calls.push("apply");
      applied.push(removed);
    },
    refreshBranches: () => calls.push("branches"),
    notify: (message) => notices.push(message),
    ...overrides,
  };
  return {
    deps,
    calls,
    notices,
    applied,
    removals,
    switchProject: () => {
      project = "/work/blog";
    },
  };
}

test("the chat is hidden before anything is removed, then the worktree goes and the state follows", async () => {
  const h = harness();
  assert.equal(await archiveChat(h.deps, 2, "delete", plan), "removed");
  assert.deepEqual(h.calls, ["stop", "hide", "remove", "apply", "branches"]);
  assert.deepEqual(h.removals, [{ path: "/tmp/wt/shop/x-1", force: true, base: "main", projectPath: "/work/shop", chatId: "/work/shop#2", seen: status }]);
  assert.deepEqual(h.applied[0], { worktreeId: 2, sessionIds: [2] });
});

test("the safe remove asks for no force", async () => {
  const h = harness();
  await archiveChat(h.deps, 2, "remove", { ...plan, status: { ...status, uncommitted: 0, removable: true } });
  assert.equal((h.removals[0] as { force: boolean }).force, false);
});

test("conversation deletion keeps the Worktree", async () => {
  const h = harness();
  assert.equal(await archiveChat(h.deps, 2, "hide", plan), "hidden");
  assert.deepEqual(h.calls, ["stop", "hide", "destroy"]);
});

test("a failed conversation deletion restores the Chat and reports the error", async () => {
  const h = harness({
    destroy: async () => {
      throw new Error("disk full");
    },
  });
  await assert.rejects(archiveChat(h.deps, 2, "hide", plan), /disk full/);
  assert.deepEqual(h.calls, ["stop", "hide", "restore"]);
  assert.deepEqual(h.removals, []);
});

test("a Worktree another Chat started using is kept while the conversation is deleted", async () => {
  const state = baseState();
  state.sessions["3"] = session(3, 2);
  const h = harness({}, state);
  assert.equal(await archiveChat(h.deps, 2, "delete", plan), "hidden");
  assert.deepEqual(h.calls, ["stop", "hide", "destroy"]);
});

test("no status from the menu, or no base, means nothing is removed", async () => {
  const h = harness();
  assert.equal(await archiveChat(h.deps, 2, "remove", { ...plan, status: null }), "hidden");
  assert.equal(await archiveChat(h.deps, 2, "remove", null), "hidden");
  assert.deepEqual(h.removals, []);
});

test("the turn winds down before the removal is asked for", async () => {
  const order: string[] = [];
  const h = harness({
    stop: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          order.push("stopped");
          resolve(undefined);
        }, 10),
      ),
    remove: async () => {
      order.push("remove");
    },
  });
  await archiveChat(h.deps, 2, "delete", plan);
  assert.deepEqual(order, ["stopped", "remove"]);
});

test("a refusal because the worktree changed keeps the worktree and brings the chat back, with a notice", async () => {
  const h = harness({
    remove: async () => {
      throw new Error("Error invoking remote method 'worktree:remove': Error: WORKTREE_CHANGED: /tmp/wt/shop/x-1 changed after it was checked.");
    },
  });
  assert.equal(await archiveChat(h.deps, 2, "delete", plan), "kept");
  assert.deepEqual(h.notices, ["It changed after you checked, so the chat and its worktree stay."]);
  assert.deepEqual(h.calls, ["stop", "hide", "restore"]);
  assert.deepEqual(h.applied, []);
});

test("a removal error keeps the worktree and brings the chat back, with git's message", async () => {
  const h = harness({
    remove: async () => {
      throw new Error("Error invoking remote method 'worktree:remove': Error: fatal: cannot remove a locked working tree");
    },
  });
  assert.equal(await archiveChat(h.deps, 2, "remove", plan), "kept");
  assert.deepEqual(h.notices, ["Couldn't remove the worktree: cannot remove a locked working tree. The chat stays so you can find it."]);
  assert.deepEqual(h.calls, ["stop", "hide", "restore"]);
  assert.deepEqual(h.removals, []);
});

test("a removal that succeeds keeps the chat archived", async () => {
  const h = harness();
  await archiveChat(h.deps, 2, "remove", { ...plan, status: { ...status, uncommitted: 0, removable: true } });
  assert.equal(h.calls.includes("restore"), false);
  assert.deepEqual(h.notices, []);
});

test("conversation deletion preserves shared and unchecked Worktrees", async () => {
  const shared = baseState();
  shared.sessions["3"] = session(3, 2);
  for (const [h, mode, p] of [
    [harness({}, shared), "delete", plan],
    [harness(), "hide", { ...plan, milagreOwned: false, status: null }],
    [harness(), "remove", { ...plan, status: null }],
    [harness(), "remove", null],
  ] as const) {
    assert.equal(await archiveChat(h.deps, 2, mode, p as ArchivePlan | null), "hidden");
    assert.deepEqual(h.calls, ["stop", "hide", "destroy"]);
    assert.deepEqual(h.removals, []);
    assert.deepEqual(h.notices, []);
  }
});

test("a project switched to midway keeps its state untouched", async () => {
  const h = harness();
  h.deps.remove = async () => {
    h.calls.push("remove");
    h.switchProject();
  };
  assert.equal(await archiveChat(h.deps, 2, "delete", plan), "removed");
  assert.deepEqual(h.calls, ["stop", "hide", "remove"]);
  assert.deepEqual(h.applied, []);
});

test("an async hide lands before the removal, and an async restore before the notice", async () => {
  const order: string[] = [];
  const later = (label: string) => () =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push(label);
        resolve();
      }, 5),
    );
  const h = harness({
    hide: later("hidden"),
    restore: later("restored"),
    remove: async () => {
      order.push("remove");
      throw new Error("fatal: busy");
    },
    notify: (message) => {
      order.push(message);
    },
  });
  assert.equal(await archiveChat(h.deps, 2, "delete", plan), "kept");
  assert.deepEqual(order, ["hidden", "remove", "restored", "Couldn't remove the worktree: busy. The chat stays so you can find it."]);
});

test("a shared Chat archives without waiting on its stop", async () => {
  const calls: string[] = [];
  // agent:interrupt that never answers (it timed out at 30 s and the Chat stayed): the archive goes through anyway.
  await archiveLinkChat({ running: true, stop: () => (calls.push("stop"), new Promise(() => {})), hide: async () => void calls.push("hide") });
  assert.deepEqual(calls, ["stop", "hide"]);
  calls.length = 0;
  await archiveLinkChat({
    running: true,
    stop: () => (calls.push("stop"), Promise.reject(new Error("Timed out: agent:interrupt."))),
    hide: async () => void calls.push("hide"),
  });
  assert.deepEqual(calls, ["stop", "hide"]);
});

test("an idle shared Chat archives without a stop", async () => {
  const calls: string[] = [];
  await archiveLinkChat({ running: false, stop: async () => void calls.push("stop"), hide: async () => void calls.push("hide") });
  assert.deepEqual(calls, ["hide"]);
});

test("a shared Chat that can't be hidden reports it", async () => {
  await assert.rejects(archiveLinkChat({ running: false, stop: async () => {}, hide: () => Promise.reject(new Error("Host offline")) }), /Host offline/);
});

test("an Undo in the window brings the Chat back and removes nothing", async () => {
  const h = harness({ undoWindow: async () => true });
  assert.equal(await archiveChat(h.deps, 2, "remove", { ...plan, status: { ...status, removable: true } }), "undone");
  assert.deepEqual(h.calls, ["stop", "hide", "restore"]);
});

test("once the window passes without an Undo, the deletion goes on", async () => {
  const h = harness({ undoWindow: async () => false });
  assert.equal(await archiveChat(h.deps, 1, "hide", null), "hidden");
  assert.deepEqual(h.calls, ["stop", "hide", "destroy"]);
});

test("undoDelete calls off only a deletion still waiting", async () => {
  const waiting = deleteUndoWindow("/work/shop#2", 10_000);
  assert.equal(undoDelete("/work/shop#2"), true);
  assert.equal(await waiting, true);
  assert.equal(undoDelete("/work/shop#2"), false);
  assert.equal(await deleteUndoWindow("/work/shop#3", 5), false);
  assert.equal(undoDelete("/work/shop#3"), false);
});
