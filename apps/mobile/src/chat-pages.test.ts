import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@milagre/shared/model";
import { mergeTail } from "./chat-pages.ts";

const message = (id: number, body = `m${id}`) => ({ id, session_id: 1, body, role: "user", context: null }) as ChatMessage;
const page = (ids: number[], hasMore = false, total = ids.length) => ({ messages: ids.map((id) => message(id)), hasMore, total });
const ids = (value: { messages: ChatMessage[] } | null) => value?.messages.map((item) => item.id);

test("the Chat's last turns read again replace the window's, keeping what came before", () => {
  const current = page([1, 2, 3, 4], true, 10);
  assert.deepEqual(ids(mergeTail(current, page([3, 4, 5], true, 11))), [1, 2, 3, 4, 5]);
  const edited = mergeTail(current, { messages: [message(3, "edited"), message(4)], hasMore: true, total: 10 });
  assert.ok(edited?.messages[2]);
  assert.equal(edited.messages[2].body, "edited");
  assert.deepEqual(ids(mergeTail(current, page([3], true, 9))), [1, 2, 3], "a removed message goes");
});

test("an unchanged tail keeps the same window, and one that starts after the window asks for a reload", () => {
  const current = page([1, 2, 3, 4], true, 10);
  assert.equal(mergeTail(current, page([3, 4], true, 10)), current);
  assert.equal(mergeTail(current, page([7, 8], true, 14)), null);
  assert.deepEqual(ids(mergeTail(page([]), page([1, 2]))), [1, 2], "an empty window takes the tail");
});
