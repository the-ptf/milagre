import { test } from "node:test";
import assert from "node:assert/strict";
import { openTab } from "@milagre/shared/workspace-tabs";
import { foldTabRows, frontChat, inScope, LINK_TABS, rowChat, scopeKey, scopeWorktree, tabsAt, tabScope } from "./workspace-tabs-kinds.ts";

const sessions = { "4": { worktree_id: 2 }, "5": { worktree_id: 3 }, "6": { worktree_id: 1 } };
const worktrees = { "1": { id: 1, path: "/repo" }, "2": { id: 2, path: "/wt/repo/chat-ab" } };
const path = "/repo";

test("a Link's Chats share one tab set, though phone snapshots give each its own Worktree", () => {
  assert.equal(tabScope({ path, link: {}, state: { sessions } }, 4, undefined), LINK_TABS);
  assert.equal(inScope({ id: 4, worktree_id: 4 }, LINK_TABS), true);
  assert.equal(inScope({ id: 5, worktree_id: 5 }, LINK_TABS), true);
  assert.equal(scopeKey("link:1", LINK_TABS), "link:1#wt:link");
});

test("a Project Chat's tab set is its Worktree's, from the Chat or the New Chat screen", () => {
  assert.equal(tabScope({ path, state: { sessions, worktrees } }, 4, undefined), 2);
  assert.equal(tabScope({ path, state: { sessions, worktrees } }, undefined, "3"), 3);
  assert.equal(tabScope({ path, state: { sessions } }, 9, undefined), undefined);
  assert.equal(tabScope(undefined, 4, undefined), undefined);
  assert.equal(inScope({ id: 4, worktree_id: 2 }, 2), true);
  assert.equal(inScope({ id: 5, worktree_id: 3 }, 2), false);
  assert.equal(scopeKey(path, 2), "/repo#wt:2");
  assert.equal(scopeWorktree(2, sessions), 2);
});

test("a Chat in the Project folder keeps a tab set of its own, and a New Chat there has none yet", () => {
  assert.equal(tabScope({ path, state: { sessions, worktrees } }, 6, undefined), "chat:6");
  assert.equal(tabScope({ path, state: { sessions, worktrees } }, undefined, "1"), undefined);
  assert.equal(inScope({ id: 6, worktree_id: 1 }, "chat:6"), true);
  assert.equal(inScope({ id: 7, worktree_id: 1 }, "chat:6"), false);
  assert.equal(scopeKey(path, "chat:6"), "/repo#chat:6");
  assert.equal(scopeWorktree("chat:6", sessions), 1);
  assert.equal(scopeWorktree(LINK_TABS, sessions), undefined);
});

test("a screen's tab set names its host and Project", () => {
  assert.deepEqual(tabsAt("host", { path, state: { sessions, worktrees } }, 4, undefined), { hostId: "host", projectPath: path, worktreeId: 2 });
  assert.deepEqual(tabsAt("host", { path, state: { sessions, worktrees } }, 6, undefined), { hostId: "host", projectPath: path, worktreeId: "chat:6" });
  assert.equal(tabsAt("host", { path, state: { sessions } }, 9, undefined), null);
  assert.equal(tabsAt("host", undefined, 4, undefined), null);
});

test("a Worktree's row opens the Chat in front of its tabs, or the Chat owning the page in front", () => {
  const chats = openTab(openTab({ tabs: [], active: null }, { kind: "chat", chatId: 4 }), { kind: "chat", chatId: 8 });
  assert.equal(frontChat(chats, [4, 8]), 8);
  assert.equal(frontChat(chats, [4]), undefined);
  const page = openTab(chats, { kind: "browser", chatId: 4, pageId: "pages" });
  assert.equal(frontChat(page, [4, 8]), 4);
  assert.equal(frontChat(openTab(chats, { kind: "diff" }), [4, 8]), undefined);
  assert.equal(frontChat({ tabs: [], active: null }, [4]), undefined);
});

const folders = { "1": { id: 1, path: "/repo" }, "2": { id: 2, path: "/wt/repo/chat-ab" }, "3": { id: 3, path: "/wt/repo/chat-cd" } };
const place = { path: "/repo", link: false, worktrees: folders };
type Item = {
  chat: { id: number; worktree_id: number; parent?: number; done_at?: number; snoozed_until?: number };
  mark: string;
  background: number;
  pending?: unknown;
};
const item = (id: number, worktree_id: number, mark = "idle", extra: Partial<Item["chat"]> = {}): Item => ({
  chat: { id, worktree_id, ...extra },
  mark,
  background: 0,
});
const ids = (rows: Item[]) => rows.map((row) => row.chat.id);

test("a Worktree Milagre made is one row: its main Chat, carrying its tab Chats' most pressing mark", () => {
  const rows = foldTabRows([item(7, 2, "idle"), item(5, 2, "unread"), item(9, 2, "question"), item(4, 3, "running")], place);
  assert.deepEqual(ids(rows), [5, 4]);
  assert.equal(rows[0]!.mark, "question");
  assert.deepEqual((rows[0] as Item & { folded?: unknown }).folded, { scope: 2, chats: [7, 9] });
  assert.equal("folded" in rows[1]!, false);
});

test("a Subchat of the Worktree's Chat folds in too, and a Subchat whose parent is elsewhere can stand for it", () => {
  assert.deepEqual(ids(foldTabRows([item(6, 2, "idle", { parent: 3 }), item(8, 2, "idle", { parent: 6 })], place)), [6]);
  assert.deepEqual(ids(foldTabRows([item(3, 2), item(6, 2, "idle", { parent: 3 })], place)), [3]);
});

test("Chats in the Project folder keep a row each", () => {
  assert.deepEqual(ids(foldTabRows([item(1, 1, "idle"), item(2, 1, "running")], place)), [1, 2]);
});

test("Done, Snoozed and still-sending Chats are not folded", () => {
  const rows = foldTabRows(
    [item(5, 2), item(6, 2, "question", { done_at: 10 }), item(7, 2, "idle", { snoozed_until: 2_000 }), { ...item(8, 2, "running"), pending: {} }],
    place,
    1_000,
  );
  assert.deepEqual(ids(rows), [5, 6, 7, 8]);
  assert.equal(rows[0]!.mark, "idle");
});

test("a Link's Chats are one row, though each has a Worktree of its own on the phone", () => {
  const rows = foldTabRows([item(4, 8, "idle"), item(3, 9, "waiting")], { path: "link:1", link: true, worktrees: {} });
  assert.deepEqual(ids(rows), [3]);
  assert.deepEqual((rows[0] as Item & { folded?: unknown }).folded, { scope: "link", chats: [4] });
});

test("a folded row opens its Worktree's front Chat on this device, a plain row its own Chat", () => {
  const front = openTab({ tabs: [], active: null }, { kind: "chat", chatId: 9 });
  const keys: string[] = [];
  const read = (key: string) => (keys.push(key), front);
  assert.equal(rowChat(read, "host", path, 5, { scope: 2, chats: [9] }), 9);
  assert.equal(rowChat(read, "host", path, 5, { scope: 2, chats: [7] }), 5);
  assert.equal(rowChat(read, "host", path, 5, undefined), 5);
  assert.deepEqual(keys, ["host|/repo#wt:2", "host|/repo#wt:2"]);
});
