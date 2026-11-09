import assert from "node:assert/strict";
import test from "node:test";
import { panelWorktree } from "./project-surfaces.ts";

test("a Chat without a Project offers no side panel Worktree, so the right-edge swipe opens no Changes", () => {
  assert.equal(panelWorktree({ kind: "chats" }, 4), undefined);
  assert.equal(panelWorktree({}, 4), 4);
  assert.equal(panelWorktree({ kind: undefined }, 0), 0);
  assert.equal(panelWorktree(undefined, undefined), undefined);
});
