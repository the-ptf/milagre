import { test } from "node:test";
import assert from "node:assert/strict";
import { inScope, LINK_TABS, tabsAt, tabScope } from "./workspace-tabs-kinds.ts";

const sessions = { "4": { worktree_id: 2 }, "5": { worktree_id: 3 } };
const path = "/repo";

test("a Link's Chats share one tab set, though phone snapshots give each its own Worktree", () => {
  assert.equal(tabScope({ path, link: {}, state: { sessions } }, 4, undefined), LINK_TABS);
  assert.equal(inScope({ worktree_id: 4 }, LINK_TABS), true);
  assert.equal(inScope({ worktree_id: 5 }, LINK_TABS), true);
});

test("a Project Chat's tab set is its Worktree's, from the Chat or the New Chat screen", () => {
  assert.equal(tabScope({ path, state: { sessions } }, 4, undefined), 2);
  assert.equal(tabScope({ path, state: { sessions } }, undefined, "3"), 3);
  assert.equal(tabScope({ path, state: { sessions } }, 9, undefined), undefined);
  assert.equal(tabScope(undefined, 4, undefined), undefined);
  assert.equal(inScope({ worktree_id: 2 }, 2), true);
  assert.equal(inScope({ worktree_id: 3 }, 2), false);
});

test("a screen's tab set names its host and Project", () => {
  assert.deepEqual(tabsAt("host", { path, state: { sessions } }, 4, undefined), { hostId: "host", projectPath: path, worktreeId: 2 });
  assert.equal(tabsAt("host", { path, state: { sessions } }, 9, undefined), null);
  assert.equal(tabsAt("host", undefined, 4, undefined), null);
});
