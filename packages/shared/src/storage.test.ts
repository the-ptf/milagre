import assert from "node:assert/strict";
import test from "node:test";
import { cleanupGroups, cleanupToast, groupLine, idleFor, removeIdleWorktrees, rowDate, rowDetail, selectionLine, type IdleWorktree } from "./storage.ts";

const DAY = 24 * 60 * 60_000;
const now = Date.UTC(2026, 10, 4, 12);
const clean = { uncommitted: 0, unpushed: 0, branch: "milagre/a", head: "a", removable: true };
const dirty = { uncommitted: 2, unpushed: 1, branch: "milagre/b", head: "b", removable: false };
const item = (title: string, daysAgo: number, bytes: number | null, status = clean, chats = 1): IdleWorktree => ({
  projectPath: "/code/app",
  projectName: "app",
  path: `/w/app/${title}`,
  branch: status.branch,
  title,
  chats,
  lastAt: now - daysAgo * DAY,
  idleBefore: now - 30 * DAY,
  activity: { worktreeId: 1, chats: [{ id: 2, lastAt: now - daysAgo * DAY, lastId: 3, count: 1 }] },
  bytes,
  status,
});

test("the days narrow the list, oldest first, and the groups split what removing loses", () => {
  const list = [item("new", 40, 1e9), item("old", 95, 2e9, dirty), item("mid", 65, 5e8)];
  assert.deepEqual(
    idleFor(list, 30, now).map((entry) => entry.title),
    ["old", "mid", "new"],
  );
  assert.deepEqual(
    idleFor(list, 60, now).map((entry) => entry.title),
    ["old", "mid"],
  );
  const groups = cleanupGroups(idleFor(list, 30, now));
  assert.deepEqual(
    groups.saved.map((entry) => entry.title),
    ["mid", "new"],
  );
  assert.equal(groupLine(groups.saved), "2 worktrees · 1.5 GB");
  assert.equal(groupLine([item("x", 40, null)]), "1 worktree", "no size before the host measured it");
  assert.equal(groupLine([]), "None");
  assert.equal(rowDetail(groups.unsaved[0]), "app · 2 uncommitted files and 1 unpushed commit will be lost");
});

test("the selection line says what goes with the worktrees", () => {
  assert.equal(selectionLine([]), "Choose the worktrees to remove.");
  assert.equal(selectionLine([item("a", 40, 1e9, clean, 2)]), "1 worktree selected · 1 GB. 2 Chats on it are deleted too.");
  assert.equal(
    selectionLine([item("a", 40, 1e9, clean, 1), item("b", 40, 1e9, dirty, 0)]),
    "2 worktrees selected · 2 GB. 1 Chat on them is deleted too. Unsaved work in 1 worktree is lost.",
  );
});

test("dates name the year only when it isn't this one", () => {
  assert.equal(rowDate(Date.UTC(2026, 8, 18, 12), now), "Sep 18");
  assert.equal(rowDate(Date.UTC(2025, 8, 18, 12), now), "Sep 18, 2025");
});

test("removal runs one at a time, forces only unsaved work, keeps going past a failure and stops when asked", async () => {
  const calls: { path: string; force: boolean }[] = [];
  const progress: number[] = [];
  const result = await removeIdleWorktrees(
    [item("a", 40, 1), item("b", 40, 1, dirty), item("c", 40, 1)],
    async (request) => {
      calls.push({ path: request.path, force: request.force });
      if (request.path.endsWith("/b")) throw new Error("it changed after it was checked");
    },
    { onProgress: (done) => progress.push(done) },
  );
  assert.deepEqual(calls, [
    { path: "/w/app/a", force: false },
    { path: "/w/app/b", force: true },
    { path: "/w/app/c", force: false },
  ]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(result, { removed: 2, failed: ["b: it changed after it was checked"], stopped: false });
  assert.equal(cleanupToast(result), "Removed 2 worktrees. One was kept: b: it changed after it was checked");

  let stop = false;
  const stopped = await removeIdleWorktrees(
    [item("a", 40, 1), item("b", 40, 1)],
    async () => {
      stop = true;
    },
    { stopped: () => stop },
  );
  assert.deepEqual(stopped, { removed: 1, failed: [], stopped: true });
  assert.equal(cleanupToast(stopped), "Removed 1 worktree. Stopped before the rest.");
});

test("both clients carry the selected idle cutoff and exact Chat snapshot to removal", async () => {
  const original = item("old", 95, 1);
  const selected = idleFor([original], 90, now);
  await removeIdleWorktrees(selected, async (request) => {
    assert.equal(request.idleBefore, now - 90 * DAY);
    assert.equal(request.lastAt, original.lastAt);
    assert.deepEqual(request.activity, original.activity);
    assert.deepEqual(request.seen, original.status);
  });
  assert.equal(original.idleBefore, now - 30 * DAY, "narrowing the selection leaves the listing unchanged");
});
