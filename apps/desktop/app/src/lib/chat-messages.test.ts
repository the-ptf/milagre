import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../model.ts";

(globalThis as { window?: unknown }).window = { milagre: {} };
const { applyChanges, noteScopeOpening, peekChatWindow, prefetchChatMessages } = await import("./chat-messages.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const message = (id: number, session_id = 1, body = `m${id}`) => ({ id, session_id, body, role: "user", context: null }) as ChatMessage;
const held = (ids: number[], hasMore = false) => ({ messages: ids.map((id) => message(id)), hasMore, total: ids.length + (hasMore ? 10 : 0), loading: false });
const ids = (window: { messages: ChatMessage[] }) => window.messages.map((item) => item.id);

test("a new reply lands after the message before it, and a changed one replaces it in place", () => {
  const window = held([1, 2, 3]);
  const added = applyChanges(window, 1, { changed: [{ message: message(4), after: 3 }], removed: [] });
  assert.deepEqual(ids(added), [1, 2, 3, 4]);
  assert.equal(added.total, 4);
  const edited = applyChanges(added, 1, { changed: [{ message: message(2, 1, "edited"), after: 1 }], removed: [] });
  assert.equal(edited.messages[1].body, "edited");
  assert.equal(edited.total, 4);
  // A message re-sent after a split reply goes after that reply, even with a lower id.
  const resent = applyChanges(held([1, 3]), 1, { changed: [{ message: message(2), after: 3 }], removed: [] });
  assert.deepEqual(ids(resent), [1, 3, 2]);
});

test("removed messages go, other Chats' changes are ignored, and nothing changing keeps the same window", () => {
  const window = held([1, 2, 3]);
  assert.deepEqual(ids(applyChanges(window, 1, { changed: [], removed: [2] })), [1, 3]);
  assert.equal(applyChanges(window, 1, { changed: [{ message: message(9, 2), after: null }], removed: [] }), window);
});

test("a message after one before the window stays out of it until older messages are read", () => {
  const window = held([5, 6], true);
  const next = applyChanges(window, 1, { changed: [{ message: message(3), after: 2 }], removed: [] });
  assert.deepEqual(ids(next), [5, 6]);
  assert.equal(next.total, window.total + 1);
});

test("a page read that reaches the host before its Project's open waits for the open, then reads again", async () => {
  let calls = 0;
  (globalThis as any).window.milagre.readChatMessages = async (_scope: string, chatId: number) => {
    calls++;
    if (calls === 1) throw new Error("Error invoking remote method 'computers:invoke': Error: Open the Project before reading its messages.");
    return { messages: [message(7, chatId)], hasMore: false, total: 1 };
  };
  let opened!: () => void;
  // A switch reads the Chat's page first, then sends the Project's open.
  prefetchChatMessages("/code/late", 4);
  noteScopeOpening("/code/late", new Promise<void>((resolve) => (opened = resolve)));
  await tick();
  assert.equal(calls, 1);
  assert.equal(peekChatWindow("/code/late", 4)?.error, undefined, "no error shows while the open is on its way");
  opened();
  await tick();
  assert.equal(calls, 2);
  assert.deepEqual(ids(peekChatWindow("/code/late", 4)!), [7]);
});

test("without an open on its way, the read's error is the window's, and asking for the Chat again reads it again", async () => {
  let calls = 0;
  (globalThis as any).window.milagre.readChatMessages = async (_scope: string, chatId: number) => {
    calls++;
    if (calls === 1) throw new Error("Open the Project before reading its messages.");
    return { messages: [message(8, chatId)], hasMore: false, total: 1 };
  };
  prefetchChatMessages("/code/closed", 5);
  await tick();
  assert.match(peekChatWindow("/code/closed", 5)?.error ?? "", /Open the Project/);
  prefetchChatMessages("/code/closed", 5);
  await tick();
  assert.equal(calls, 2);
  assert.deepEqual(ids(peekChatWindow("/code/closed", 5)!), [8]);
  prefetchChatMessages("/code/closed", 5);
  await tick();
  assert.equal(calls, 2, "a window read already is left alone");
});
