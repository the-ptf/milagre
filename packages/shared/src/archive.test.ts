import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, ChatMessage, CoordinatorState, Worktree } from "./model.ts";
import { archiveChoices, isInsideRoots, isMilagreWorktree, lossReason, removeFailureNotice, worktreeShared } from "./archive.mjs";
import type { ArchivePlan, WorktreeStatus } from "./archive.mjs";

const clean: WorktreeStatus = { uncommitted: 0, unpushed: 0, branch: "milagre/x", head: "abc", removable: true };
const dirty: WorktreeStatus = { uncommitted: 3, unpushed: 2, branch: "milagre/x", head: "abc", removable: false };
const plan = (patch: Partial<ArchivePlan> = {}): ArchivePlan => ({ milagreOwned: true, shared: false, status: clean, ...patch });
const labels = (result: ReturnType<typeof archiveChoices>) => result.choices.map((choice) => choice.label);

test("a clean Milagre worktree offers one item that removes it", () => {
  const result = archiveChoices({ plan: plan(), running: false });
  assert.deepEqual(result.choices, [{ mode: "remove", label: "Archive and remove worktree", tone: "plain" }]);
  assert.equal(result.reason, null);
  assert.deepEqual(labels(archiveChoices({ plan: plan(), running: true })), ["Stop, archive and remove worktree"]);
});

test("a worktree with unsaved work offers only delete, with what would be lost and how to keep it", () => {
  const result = archiveChoices({ plan: plan({ status: dirty }), running: false });
  assert.deepEqual(
    result.choices.map((choice) => [choice.mode, choice.label, choice.tone]),
    [["delete", "Archive and delete worktree", "danger"]],
  );
  assert.equal(result.reason, "3 uncommitted files and 2 unpushed commits will be lost. Commit and push them first to keep them.");
  assert.deepEqual(labels(archiveChoices({ plan: plan({ status: dirty }), running: true })), ["Stop, archive and delete worktree"]);
  assert.equal(
    archiveChoices({ plan: plan({ status: { ...dirty, unpushed: 0, uncommitted: 2 } }), running: false }).reason,
    "2 uncommitted files will be lost. Commit them first to keep them.",
  );
  assert.equal(
    archiveChoices({ plan: plan({ status: { ...dirty, uncommitted: 0, unpushed: 1 } }), running: false }).reason,
    "1 unpushed commit will be lost. Push them first to keep them.",
  );
  const detached = archiveChoices({ plan: plan({ status: { ...dirty, uncommitted: 0, unpushed: 0, branch: null } }), running: false });
  assert.equal(detached.reason, "Its HEAD is detached, so what it holds isn't on a branch. Check out a branch first to keep it.");
  // Nothing offers to keep the worktree.
  for (const status of [dirty, clean])
    assert.equal(
      labels(archiveChoices({ plan: plan({ status }), running: false })).some((label) => /keep/i.test(label)),
      false,
    );
});

// A project-less Chat works on a worktree at `<worktree root>/chats/<slug>` with its base recorded, as worktree:create
// makes it in the Chats home (an internal repository). Whether that counts as Milagre's is decided by isMilagreWorktree
// against the real roots, never assumed, so these tests fail if that layout ever stops being Milagre-made.
const worktreeRoot = "/tmp/wt";
const chatsWorktree = { id: 3, project_id: 1, path: `${worktreeRoot}/chats/chat-k95o`, name: "milagre/chat-k95o", base: "main" };
const chatsPlan = (status: WorktreeStatus) => plan({ milagreOwned: isMilagreWorktree(chatsWorktree, [worktreeRoot]), status });

test("archiveChoices for a clean Chats home worktree offers only remove", () => {
  assert.equal(chatsPlan(clean).milagreOwned, true);
  const result = archiveChoices({ plan: chatsPlan(clean), running: false });
  assert.deepEqual(
    result.choices.map((choice) => choice.mode),
    ["remove"],
  );
  assert.equal(result.reason, null);
});

test("archiveChoices for a Chats home worktree with uncommitted files offers only delete, in the danger tone", () => {
  const files: WorktreeStatus = { uncommitted: 2, unpushed: 0, branch: "milagre/chat-k95o", head: "abc", removable: false };
  assert.equal(chatsPlan(files).milagreOwned, true);
  const result = archiveChoices({ plan: chatsPlan(files), running: false });
  assert.deepEqual(
    result.choices.map((choice) => [choice.mode, choice.tone]),
    [["delete", "danger"]],
  );
  assert.equal(result.reason, "2 uncommitted files will be lost. Commit them first to keep them.");
});

test("a clean Chat without a Project archives in one click, labelled Archive", () => {
  const result = archiveChoices({ plan: chatsPlan(clean), running: false, chatsHome: true });
  assert.deepEqual(result.choices, [{ mode: "remove", label: "Archive", tone: "plain" }]);
  assert.equal(result.reason, null);
  assert.equal(result.immediate, true);
  assert.deepEqual(labels(archiveChoices({ plan: chatsPlan(clean), running: true, chatsHome: true })), ["Stop and archive"]);
  // A busy Terminal still gets its line, so the step stays.
  const busy = archiveChoices({ plan: { ...chatsPlan(clean), terminals: ["npm run dev"] }, running: false, chatsHome: true });
  assert.equal(busy.immediate, false);
  assert.equal(busy.reason, "Archiving ends the Terminal running npm run dev.");
});

test("a Chat without a Project with files offers only Delete chat and its files, with no Git words", () => {
  const files: WorktreeStatus = { uncommitted: 2, unpushed: 1, branch: "milagre/chat-k95o", head: "abc", removable: false };
  const result = archiveChoices({ plan: chatsPlan(files), running: false, chatsHome: true });
  assert.deepEqual(result.choices, [{ mode: "delete", label: "Delete chat and its files", tone: "danger" }]);
  assert.equal(result.reason, "Its folder has 2 changed files that will be deleted.");
  assert.equal(result.immediate, false);
  assert.equal(
    archiveChoices({ plan: chatsPlan({ ...files, uncommitted: 1 }), running: true, chatsHome: true }).choices[0]?.label,
    "Stop and delete chat and its files",
  );
  assert.equal(
    archiveChoices({ plan: chatsPlan({ ...files, uncommitted: 1 }), running: false, chatsHome: true }).reason,
    "Its folder has 1 changed file that will be deleted.",
  );
  assert.equal(
    archiveChoices({ plan: chatsPlan({ ...files, uncommitted: 0 }), running: false, chatsHome: true }).reason,
    "Its folder has saved work that will be deleted.",
  );
  for (const status of [clean, files]) {
    const { choices, reason } = archiveChoices({ plan: chatsPlan(status), running: false, chatsHome: true });
    for (const words of [...choices.map((choice) => choice.label), reason ?? ""]) assert.doesNotMatch(words, /worktree|commit|branch|HEAD|push/i);
  }
  // Project Chats are never immediate.
  assert.equal(archiveChoices({ plan: plan(), running: false }).immediate, false);
});

test("a Chats home worktree is Milagre's only with its base recorded and under a root", () => {
  assert.equal(isMilagreWorktree({ ...chatsWorktree, base: undefined }, [worktreeRoot]), false);
  assert.equal(isMilagreWorktree(chatsWorktree, ["/elsewhere"]), false);
});

test("a check that failed never offers deletion", () => {
  for (const running of [false, true]) {
    const result = archiveChoices({ plan: plan({ status: null }), running });
    assert.deepEqual(
      result.choices.map((choice) => choice.mode),
      ["hide"],
    );
  }
});

test("a worktree that isn't Milagre's, is shared, or can't be checked only hides the chat", () => {
  for (const patch of [{ milagreOwned: false }, { shared: true }, { status: null }]) {
    const result = archiveChoices({ plan: plan(patch), running: false });
    assert.deepEqual(result.choices, [{ mode: "hide", label: "Confirm archive", tone: "danger" }]);
    assert.equal(result.reason, null);
  }
  assert.deepEqual(labels(archiveChoices({ plan: plan({ shared: true }), running: true })), ["Stop and archive"]);
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

test("archiving names the commands its Terminals would end", () => {
  assert.equal(archiveChoices({ plan: plan({ terminals: ["npm"] }), running: false }).reason, "Archiving ends the Terminal running npm.");
  assert.equal(
    archiveChoices({ plan: { milagreOwned: false, shared: false, status: null, terminals: ["npm", "vim", "npm"] }, running: false }).reason,
    "Archiving ends 3 Terminals running npm, vim.",
  );
  assert.equal(
    archiveChoices({ plan: plan({ status: { ...dirty, unpushed: 0, uncommitted: 2 }, terminals: ["node"] }), running: false }).reason,
    "2 uncommitted files will be lost. Commit them first to keep them. Archiving ends the Terminal running node.",
  );
  assert.equal(archiveChoices({ plan: plan({ terminals: [] }), running: false }).reason, null);
});
