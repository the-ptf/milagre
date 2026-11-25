import assert from "node:assert/strict";
import test from "node:test";
import {
  closeOtherTabs,
  closeTab,
  EMPTY_TABS,
  keepListedChats,
  mainChatId,
  moveTab,
  openTab,
  parseTabSets,
  pruneTabSets,
  selectTab,
  setBeside,
  subchatAnchor,
  tabForDigit,
  tabId,
  tabShortcutDigit,
  workspaceKey,
  type TabSet,
} from "./workspace-tabs.ts";

const chat = (chatId: number) => ({ kind: "chat" as const, chatId });
const ids = (set: TabSet) => set.tabs.map(tabId);
const three = [chat(1), chat(2), chat(3)].reduce((set, tab) => openTab(set, tab), EMPTY_TABS);

test("Chats of one Worktree share a tab set; a Chat without one gets its own", () => {
  assert.equal(workspaceKey("/p", 7, 1), workspaceKey("/p", 7, 2));
  assert.equal(workspaceKey("/p", null, 1), "/p#chat:1");
  assert.notEqual(workspaceKey("/p", undefined, 1), workspaceKey("/p", undefined, 2));
});

test("opening a tab brings it forward, and opening it again does not duplicate it", () => {
  assert.deepEqual(ids(three), ["chat:1", "chat:2", "chat:3"]);
  assert.equal(three.active, "chat:3");
  const again = openTab(three, chat(1));
  assert.deepEqual(ids(again), ids(three));
  assert.equal(again.active, "chat:1");
});

test("a tab opened in the background lands unread and clears once selected", () => {
  const page = { kind: "browser" as const, chatId: 1, pageId: "a" };
  const opened = openTab(three, page, { focus: false });
  assert.equal(opened.active, "chat:3");
  assert.equal(opened.tabs.at(-1)?.unread, true);
  const seen = selectTab(opened, tabId(page));
  assert.equal(seen.tabs.at(-1)?.unread, undefined);
  assert.equal(seen.active, tabId(page));
});

test("closing the tab in front brings its left neighbour forward", () => {
  const closed = closeTab(selectTab(three, "chat:2"), "chat:2");
  assert.deepEqual(ids(closed), ["chat:1", "chat:3"]);
  assert.equal(closed.active, "chat:1");
  assert.equal(closeTab(selectTab(three, "chat:1"), "chat:1").active, "chat:2");
  assert.equal(closeTab(three, "chat:1").active, "chat:3");
  assert.deepEqual(closeTab(openTab(EMPTY_TABS, chat(1)), "chat:1"), EMPTY_TABS);
});

test("close other tabs keeps only the chosen one, in front", () => {
  assert.deepEqual(closeOtherTabs(three, "chat:2"), { tabs: [chat(2)], active: "chat:2" });
});

test("a dragged tab drops at its new place", () => {
  assert.deepEqual(ids(moveTab(three, "chat:3", 0)), ["chat:3", "chat:1", "chat:2"]);
  assert.deepEqual(ids(moveTab(three, "chat:1", 99)), ["chat:2", "chat:3", "chat:1"]);
  assert.equal(moveTab(three, "chat:2", 1), three);
});

test("a Subchat opens after its parent and the family tabs already beside it", () => {
  const parents: Record<number, number> = { 4: 1, 5: 1, 6: 4 };
  const parentOf = (id: number) => parents[id];
  let set = openTab(three, chat(4), { after: subchatAnchor(three, 1, parentOf) });
  assert.deepEqual(ids(set), ["chat:1", "chat:4", "chat:2", "chat:3"]);
  set = openTab(set, chat(6), { after: subchatAnchor(set, 4, parentOf) });
  set = openTab(set, chat(5), { after: subchatAnchor(set, 1, parentOf) });
  assert.deepEqual(ids(set), ["chat:1", "chat:4", "chat:6", "chat:5", "chat:2", "chat:3"]);
  assert.equal(subchatAnchor(three, 9, parentOf), undefined);
});

test("tabs of Chats that are gone close, with the pages they own", () => {
  let set = openTab(three, { kind: "browser", chatId: 2, pageId: "a" });
  set = openTab(set, { kind: "diff" });
  set = selectTab(set, "browser:2:a");
  const kept = keepListedChats(set, (id) => id !== 2);
  assert.deepEqual(ids(kept), ["chat:1", "chat:3", "diff"]);
  assert.equal(kept.active, "chat:3");
  assert.equal(
    keepListedChats(three, () => true),
    three,
  );
});

test("⌘1 to ⌘8 pick the first eight tabs and ⌘9 the last", () => {
  const many = Array.from({ length: 11 }, (_, index) => chat(index + 1)).reduce((set, tab) => openTab(set, tab), EMPTY_TABS);
  assert.equal(tabShortcutDigit(many, "chat:1"), 1);
  assert.equal(tabShortcutDigit(many, "chat:9"), undefined);
  assert.equal(tabShortcutDigit(many, "chat:11"), 9);
  assert.equal(tabShortcutDigit(three, "chat:3"), 3);
  assert.equal(tabForDigit(many, 9)?.kind === "chat" && tabForDigit(many, 9)?.chatId, 11);
  assert.equal(tabForDigit(many, 0), undefined);
});

test("stored tab sets survive damage and keep the most recent", () => {
  const parsed = parseTabSets(
    JSON.stringify({
      a: { tabs: [chat(1), { kind: "nope" }, { kind: "pr", number: 3 }], active: "pr:3", at: 5 },
      b: { tabs: "broken" },
      c: { tabs: [chat(2)], active: "chat:9" },
    }),
  );
  assert.deepEqual(parsed.a, { tabs: [chat(1), { kind: "pr", number: 3 }], active: "pr:3", at: 5 });
  assert.equal(parsed.b, undefined);
  assert.equal(parsed.c?.active, "chat:2");
  assert.deepEqual(parseTabSets("{oops"), {});
  const pruned = pruneTabSets({ old: { ...three, at: 1 }, empty: { ...EMPTY_TABS, at: 9 }, recent: { ...three, at: 3 } }, 1);
  assert.deepEqual(Object.keys(pruned), ["recent"]);
});

test("the main Chat is the Worktree's oldest Chat that is no one's Subchat", () => {
  assert.equal(mainChatId([{ id: 7 }, { id: 3, parent: 1 }, { id: 5 }, { id: 2, archived: true }]), 5);
  assert.equal(mainChatId([]), undefined);
});

test("a page tab can sit beside its Chat and go back on its own", () => {
  const page = { kind: "browser" as const, chatId: 1, pageId: "a" };
  const set = openTab(three, page);
  const beside = setBeside(set, tabId(page), true);
  assert.equal(beside.tabs.at(-1)?.beside, true);
  assert.equal(setBeside(beside, tabId(page), true), beside);
  assert.equal(setBeside(beside, tabId(page), false).tabs.at(-1)?.beside, undefined);
  assert.equal(openTab(three, chat(9), { focus: false, unread: false }).tabs.at(-1)?.unread, undefined);
});
