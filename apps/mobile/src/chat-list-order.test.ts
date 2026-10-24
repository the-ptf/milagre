import { test } from "node:test";
import assert from "node:assert/strict";
import { compareAcross, mergeChatLists } from "./chat-list-order.ts";

const chat = (name: string, rank: number, lastAt: number | undefined, extra: { pinned?: boolean; pin_order?: number; firstAt?: number } = {}) => {
  const { firstAt, ...pins } = extra;
  return { name, rank, chat: { summary: { count: 1, lastAt, firstAt }, ...pins } };
};

test("pinned Chats come first in their pin order, then the later activity", () => {
  assert.ok(compareAcross(chat("pin", 1, 1, { pinned: true, pin_order: 0 }), chat("new", 0, 99)) < 0);
  assert.ok(compareAcross(chat("a", 1, 1, { pinned: true, pin_order: 2 }), chat("b", 0, 1, { pinned: true, pin_order: 1 })) > 0);
  assert.ok(compareAcross(chat("late", 1, 9), chat("early", 0, 3)) < 0);
  assert.ok(compareAcross(chat("first", 0, 3), chat("second", 1, 3)) < 0);
});

test("the Chat that began later comes first, whatever its last activity; a host with neither keeps its Project's order", () => {
  assert.ok(compareAcross(chat("new", 1, 5, { firstAt: 100 }), chat("old-but-busy", 0, 99, { firstAt: 10 })) < 0);
  assert.ok(
    compareAcross(chat("began-late", 1, 5, { firstAt: 100 }), chat("only-last", 0, 50)) < 0,
    "firstAt is the key when a Chat has one, lastAt otherwise",
  );
  const a = [chat("a-new", 0, undefined), chat("a-old", 0, undefined)];
  const b = [chat("b-new", 1, undefined), chat("b-old", 1, undefined)];
  assert.deepEqual(
    mergeChatLists([a, b]).map((row) => row.name),
    ["a-new", "a-old", "b-new", "b-old"],
    "rows with no time keep each Project's own order and its place in the list",
  );
});

test("each Project keeps its own order and the lists interleave by the next Chat of each", () => {
  // Project A is sorted by when its Chats began, so an older-active Chat can sit above a newer-active one.
  const a = [chat("a-started-last", 0, 5), chat("a-started-first", 0, 20)];
  const b = [chat("b1", 1, 10), chat("b2", 1, 4)];
  assert.deepEqual(
    mergeChatLists([a, b]).map((row) => row.name),
    ["b1", "a-started-last", "a-started-first", "b2"],
  );
});

test("pins from every Project lead, and empty lists are skipped", () => {
  const a = [chat("a-pin", 0, 1, { pinned: true, pin_order: 5 }), chat("a-new", 0, 50)];
  const b = [chat("b-pin", 1, 1, { pinned: true, pin_order: 1 }), chat("b-new", 1, 60)];
  assert.deepEqual(
    mergeChatLists([a, [], b]).map((row) => row.name),
    ["b-pin", "a-pin", "b-new", "a-new"],
  );
  assert.deepEqual(mergeChatLists([]), []);
});
