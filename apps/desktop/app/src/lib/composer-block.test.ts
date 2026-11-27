import assert from "node:assert/strict";
import test from "node:test";
import { RUN_WORKTREE_REMOVED_NOTE } from "@milagre/shared/routines";
import { ARCHIVED_CHAT_NOTE } from "@milagre/shared/message-search-view";
import { composerBlock } from "./composer-block.ts";

test("an archived Chat opens read-only with a way back, and opening it restores nothing", () => {
  const restored: number[] = [];
  const block = composerBlock({ id: 4, archived: true }, { runPane: false, restore: (id) => restored.push(id) });
  assert.deepEqual([block.note, block.blocked], [ARCHIVED_CHAT_NOTE, true]);
  assert.deepEqual(restored, []);
  block.restore?.();
  assert.deepEqual(restored, [4]);
});

test("a read-only reason wins over archived, and a removed Run Worktree blocks without a Restore", () => {
  const restore = () => {};
  assert.deepEqual(composerBlock({ id: 1, archived: true, readOnlyReason: "Preserved." }, { runPane: false, restore }), { note: "Preserved.", blocked: true });
  assert.deepEqual(composerBlock({ id: 1, formerWorktree: { path: "/w", name: "w" } } as never, { runPane: false, restore }), {
    note: RUN_WORKTREE_REMOVED_NOTE,
    blocked: true,
  });
  assert.deepEqual(composerBlock(undefined, { runPane: true, restore }), { blocked: false });
});
