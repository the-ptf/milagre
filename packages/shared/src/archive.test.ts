import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, ChatMessage, CoordinatorState, Worktree } from "./model.ts";
import { archiveChoices, archiveMode, isInsideRoots, isMilagreWorktree, lossReason, removeFailureNotice, worktreeShared } from "./archive.mjs";
import type { ArchivePlan, WorktreeStatus } from "./archive.mjs";

const clean: WorktreeStatus = { uncommitted: 0, unpushed: 0, branch: "milagre/x", head: "abc", removable: true };
const dirty: WorktreeStatus = { uncommitted: 3, unpushed: 2, branch: "milagre/x", head: "abc", removable: false };
const plan = (patch: Partial<ArchivePlan> = {}): ArchivePlan => ({ milagreOwned: true, shared: false, status: clean, ...patch });
test("Delete acts immediately without a confirmation or explanatory text for every cleanup mode", () => {
  const cases: [Partial<ArchivePlan>, string][] = [
    [{}, "remove"],
    [{ status: dirty }, "hide"],
    [{ shared: true }, "hide"],
    [{ milagreOwned: false }, "hide"],
    [{ status: null }, "hide"],
  ];
  for (const [patch, mode] of cases)
    for (const running of [false, true])
      for (const chatsHome of [false, true]) {
        const result = archiveChoices({ plan: plan({ ...patch, terminals: ["npm"] }), running, chatsHome });
        assert.deepEqual(result, { choices: [{ mode, label: "Delete", tone: "danger" }], reason: null, immediate: true });
      }
});

test("archive removes only a clean, unshared Milagre worktree", () => {
  assert.equal(archiveMode(plan()), "remove");
  for (const patch of [{ status: dirty }, { status: null }, { shared: true }, { milagreOwned: false }, { terminals: ["npm"], status: dirty }]) {
    assert.equal(archiveMode(plan(patch)), "hide");
  }
  assert.equal(archiveMode(null), "hide");
  assert.equal(archiveMode(plan({ status: { ...dirty, branch: null } })), "hide");
  assert.equal(archiveMode(plan({ terminals: ["npm"] })), "remove");
});

test("lossReason names only what is lost, in singular or plural", () => {
  assert.equal(lossReason({ ...dirty, uncommitted: 1, unpushed: 0 }), "1 uncommitted file will be lost");
  assert.equal(lossReason({ ...dirty, uncommitted: 0, unpushed: 1 }), "1 unpushed commit will be lost");
  assert.equal(lossReason({ ...dirty, uncommitted: 1, unpushed: 4 }), "1 uncommitted file and 4 unpushed commits will be lost");
});

test("isInsideRoots needs a folder under a root, not the root or a lookalike", () => {
  const roots = ["/tmp/wt", "/private/tmp/wt/"];
  assert.equal(isInsideRoots("/tmp/wt/shop/x-1", roots), true);
  assert.equal(isInsideRoots("/private/tmp/wt/shop/x-1", roots), true);
  assert.equal(isInsideRoots("/tmp/wt", roots), false);
  assert.equal(isInsideRoots("/tmp/wt/", roots), false);
  assert.equal(isInsideRoots("/tmp/wt-other/shop", roots), false);
  assert.equal(isInsideRoots("/work/shop", roots), false);
  assert.equal(isInsideRoots("/tmp/wt/shop", []), false);
});

test("a Milagre worktree has a base and lives under the root", () => {
  const worktree: Worktree = { id: 2, project_id: 1, path: "/tmp/wt/shop/x-1", name: "milagre/x-1", base: "main" };
  assert.equal(isMilagreWorktree(worktree, ["/tmp/wt"]), true);
  assert.equal(isMilagreWorktree({ ...worktree, base: undefined }, ["/tmp/wt"]), false);
  assert.equal(isMilagreWorktree({ ...worktree, path: "/work/shop" }, ["/tmp/wt"]), false);
  assert.equal(isMilagreWorktree(undefined, ["/tmp/wt"]), false);
});

const session = (id: number, worktree_id: number, extra: Partial<AgentSession> = {}): AgentSession =>
  ({ id, worktree_id, agent_name: "x", status: "Created", ...extra }) as AgentSession;
const message = (id: number, session_id: number) => ({ id, session_id, body: "hi", context: null, role: "user" }) as ChatMessage;
const state = (): CoordinatorState => ({
  next_id: 10,
  projects: {},
  worktrees: {
    "1": { id: 1, project_id: 1, path: "/work/shop", name: "main" },
    "2": { id: 2, project_id: 1, path: "/tmp/wt/shop/x-1", name: "milagre/x-1", base: "main" },
    "3": { id: 3, project_id: 1, path: "/tmp/wt/shop/y-1", name: "milagre/y-1", base: "main" },
  },
  sessions: { "1": session(1, 1), "2": session(2, 2), "3": session(3, 2), "4": session(4, 3) },
  connections: { "1": { id: 1, left_worktree_id: 1, right_worktree_id: 2, kind: "Information", lifetime: "Persistent" } as never },
  events: [
    { id: 1, worktree_id: 2, kind: "Change", summary: "", details: "" },
    { id: 2, worktree_id: 3, kind: "Change", summary: "", details: "" },
  ],
  messages: [message(1, 2), message(2, 3), message(3, 4)],
  approvals: [],
  tasks: { "1": { id: 1, worktree_id: 2, title: "t", status: "open" } },
  artifacts: {},
  outputs: [],
  conflicts: [],
});

test("worktreeShared: any other unarchived chat in the same worktree, even an empty one", () => {
  const initial = state();
  assert.equal(worktreeShared(initial, 2), true);
  assert.equal(worktreeShared(initial, 4), false);
  assert.equal(worktreeShared({ ...initial, sessions: { ...initial.sessions, 3: session(3, 2, { archived: true }) } }, 2), false);
  assert.equal(worktreeShared({ ...initial, messages: initial.messages.filter((item) => item.session_id !== 3) }, 2), true);
  assert.equal(worktreeShared(initial, 99), false);
});

test("removeFailureNotice names git's message, says the chat stays, and has no path", () => {
  assert.equal(
    removeFailureNotice(new Error("Error invoking remote method 'worktree:remove': Error: fatal: cannot remove a locked working tree\n")),
    "Couldn't remove the worktree: cannot remove a locked working tree. The chat stays so you can find it.",
  );
  assert.equal(removeFailureNotice("boom."), "Couldn't remove the worktree: boom. The chat stays so you can find it.");
  assert.equal(
    removeFailureNotice(new Error("Error invoking remote method 'worktree:remove': Error: WORKTREE_CHANGED: /tmp/wt/x changed after it was checked.")),
    "It changed after you checked, so the chat and its worktree stay.",
  );
});
