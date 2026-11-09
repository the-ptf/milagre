import assert from "node:assert/strict";
import test from "node:test";
import { canvasAttention, canvasFilterCounts, canvasStatus, canvasWorktrees, matchesCanvasFilter, type CanvasMark } from "./canvas.ts";
import type { AgentSession, CoordinatorState, Worktree } from "./model.ts";

const worktree = (id: number, name: string, extra: Partial<Worktree> = {}): Worktree => ({ id, project_id: 1, path: `/repo/${name}`, name, ...extra });
const session = (id: number, worktree_id: number, extra: Partial<AgentSession> = {}): AgentSession => ({
  id,
  worktree_id,
  agent_name: `agent ${id}`,
  status: "Idle",
  summary: { count: 2, firstId: id, lastId: id, lastAt: 1000, titleLine: `Chat ${id}` },
  ...extra,
});
const state = (worktrees: Worktree[], sessions: AgentSession[]): CoordinatorState => ({
  next_id: 100,
  projects: {},
  worktrees: Object.fromEntries(worktrees.map((item) => [item.id, item])),
  sessions: Object.fromEntries(sessions.map((item) => [item.id, item])),
  messages: [],
  tasks: {},
});
const idle = (): CanvasMark => "idle";
const chats = (marks: CanvasMark[]) => ({ chats: marks.map((mark) => ({ mark })) });

test("the canvas shows only Worktrees with a chat the sidebar lists", () => {
  const worktrees = canvasWorktrees(
    state(
      [worktree(1, "main"), worktree(2, "finished"), worktree(3, "starter"), worktree(4, "live", { diff: { added: 3, removed: 1 } })],
      [
        session(10, 1),
        session(11, 2, { archived: true }),
        session(12, 3, { summary: { count: 0 } }),
        session(13, 4, { provider: "codex" }),
        session(14, 4, { title: "Review it" }),
      ],
    ),
    idle,
  );
  assert.deepEqual(
    worktrees.map((item) => [item.branch, item.chats.map((chat) => chat.title)]),
    [
      ["main", ["Chat 10"]],
      ["live", ["Chat 13", "Review it"]],
    ],
  );
  assert.deepEqual(worktrees[1].diff, { added: 3, removed: 1 });
  assert.equal(worktrees[1].chats[0].provider, "codex");
});

test("a Worktree whose only Chat is a hidden Run Chat is left out until the Chat waits on someone", () => {
  const hidden = session(10, 2, { routine: { routineId: "r", runId: "u", hidden: true } });
  const base = state([worktree(1, "main"), worktree(2, "runs")], [session(11, 1), hidden]);
  assert.deepEqual(
    canvasWorktrees(base, idle).map((item) => item.branch),
    ["main"],
  );
  for (const mark of ["waiting", "question"] as const) {
    const shown = canvasWorktrees(base, (id) => (id === 10 ? mark : "idle"));
    assert.deepEqual(
      shown.map((item) => [item.branch, item.chats.map((chat) => chat.id)]),
      [
        ["main", [11]],
        ["runs", [10]],
      ],
    );
  }
  for (const mark of ["running", "background", "unread", "delegated"] as const)
    assert.deepEqual(
      canvasWorktrees(base, () => mark).map((item) => item.branch),
      ["main"],
    );
});

test("a Worktree in a named Link's shared conversation stays, with no chats of its own", () => {
  const shared = { linkId: "link-1", sessionId: 7 };
  const worktrees = canvasWorktrees(state([worktree(1, "member", { sharedChat: shared }), worktree(2, "idle")], [session(10, 2, { archived: true })]), idle);
  assert.deepEqual(worktrees, [{ id: 1, path: "/repo/member", branch: "member", diff: undefined, chats: [], sharedChat: shared }]);
});

test("a chat's mark comes from the platform's runs, with its unread flag", () => {
  const seen: Array<[number, boolean]> = [];
  const [only] = canvasWorktrees(state([worktree(1, "main")], [session(10, 1, { unread: true })]), (id, unread) => {
    seen.push([id, unread]);
    return "running";
  });
  assert.deepEqual(seen, [[10, true]]);
  assert.equal(only.chats[0].mark, "running");
});

test("an older host's chats without a summary are read from their messages", () => {
  const legacy = state([worktree(1, "main")], [session(10, 1, { summary: undefined }), session(11, 1, { summary: undefined })]);
  legacy.messages = [{ id: 1, session_id: 10, role: "user", body: "Fix the flicker\nmore" } as CoordinatorState["messages"][number]];
  assert.deepEqual(
    canvasWorktrees(legacy, idle)[0].chats.map((chat) => chat.title),
    ["Fix the flicker"],
  );
});

test("status words say what a chat is doing, or how long it has been quiet", () => {
  const now = 10 * 60_000;
  assert.deepEqual(canvasStatus({ mark: "waiting", failed: false }, now), { label: "Waiting for you", tone: "orange" });
  assert.deepEqual(canvasStatus({ mark: "question", failed: false }, now), { label: "Asking you", tone: "accent" });
  assert.deepEqual(canvasStatus({ mark: "delegated", failed: false }, now), { label: "Working on a Delegation", tone: "accent" });
  assert.deepEqual(canvasStatus({ mark: "running", failed: false }, now), { label: "Running", tone: "accent" });
  assert.deepEqual(canvasStatus({ mark: "idle", failed: false, lastAt: now - 25 * 60_000 }, now + 0), { label: "Idle · 25m ago", tone: "ink3" });
  assert.deepEqual(canvasStatus({ mark: "idle", failed: false, lastAt: now - 1000 }, now), { label: "Idle · just now", tone: "ink3" });
  assert.deepEqual(canvasStatus({ mark: "idle", failed: false }, now), { label: "Idle", tone: "ink3" });
  assert.deepEqual(canvasStatus({ mark: "unread", failed: false, lastAt: now - 3 * 60_000 }, now), { label: "Finished · 3m ago", tone: "accent" });
  assert.deepEqual(canvasStatus({ mark: "idle", failed: true, lastAt: now - 3 * 60_000 }, now), { label: "Failed · 3m ago", tone: "red" });
});

test("a card's outline follows its most urgent chat", () => {
  assert.equal(canvasAttention([{ mark: "question" }, { mark: "waiting" }]), "waiting");
  assert.equal(canvasAttention([{ mark: "running" }, { mark: "question" }]), "question");
  assert.equal(canvasAttention([{ mark: "running" }, { mark: "idle" }]), undefined);
});

test("the filter keeps chats that need you or are running, and counts them", () => {
  assert.equal(matchesCanvasFilter("question", "needs-you"), true);
  assert.equal(matchesCanvasFilter("delegated", "needs-you"), false);
  assert.equal(matchesCanvasFilter("delegated", "running"), true);
  assert.equal(matchesCanvasFilter("unread", "running"), false);
  assert.equal(matchesCanvasFilter("idle", "all"), true);
  assert.deepEqual(canvasFilterCounts([chats(["waiting", "idle"]), chats(["running", "question", "delegated"])]), { all: 5, "needs-you": 2, running: 2 });
});
