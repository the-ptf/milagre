import assert from "node:assert/strict";
import test from "node:test";
import { ChatWindowCache, prependChatPage } from "./chat-window-cache.ts";

const page = (count: number, body = "x") => ({
  messages: Array.from({ length: count }, (_, id) => ({ id, role: id % 2 ? "assistant" : "user", body })),
  total: count,
  hasMore: false,
  loading: false,
});
const cache = (maxBytes = 10_000) => new ChatWindowCache<ReturnType<typeof page>>({ maxChats: 2, maxBytes, turns: 2 });

test("leaving a Chat releases expanded history, preserves total and makes older turns reloadable", async () => {
  const c = cache();
  c.retain("a");
  const all = page(100);
  c.set("a", all);
  assert.equal(c.get("a"), all, "active history is never trimmed");
  c.release("a");
  await Promise.resolve();
  const tail = c.get("a")!;
  assert.deepEqual(
    tail.messages.map((m) => m.id),
    [96, 97, 98, 99],
  );
  assert.equal(tail.total, 100);
  assert.equal(tail.hasMore, true);
});

test("cache pressure evicts the least recently read inactive Chats, including a single large message", async () => {
  const c = cache(1000);
  c.set("a", page(2));
  c.set("b", page(2));
  c.retain("a");
  c.release("a");
  await Promise.resolve();
  c.set("c", page(2));
  assert.equal(c.has("b"), false);
  assert.equal(c.has("a"), true);
  c.set("large", page(1, "x".repeat(2000)));
  assert.equal(c.has("large"), false);
});

test("all active readers are protected until the last unsubscribe, even above budget", async () => {
  const c = cache(10);
  c.retain("a");
  c.retain("a");
  const all = page(100);
  c.set("a", all);
  c.release("a");
  await Promise.resolve();
  assert.equal(c.get("a"), all);
  c.release("a");
  await Promise.resolve();
  assert.equal(c.has("a"), false);
});

test("a late history response for an inactive Chat is trimmed too; pending/error state stays intact", async () => {
  const c = cache();
  c.retain("a");
  c.set("a", page(10));
  c.release("a");
  await Promise.resolve();
  c.set("a", { ...page(200), loading: true });
  assert.equal(c.get("a")!.messages.length, 4);
  assert.equal(c.get("a")!.loading, true);
});

test("a delayed earlier page cannot create an unfillable gap after leave and reopen", async () => {
  const c = new ChatWindowCache<ReturnType<typeof page>>({ maxChats: 2, maxBytes: 100000, turns: 20 });
  const all = page(60);
  all.messages = all.messages.map((m) => ({ ...m, id: m.id + 1, role: "user" }));
  const expanded = { ...all, messages: all.messages.slice(20), hasMore: true };
  c.retain("a");
  c.set("a", expanded);
  const before = expanded.messages[0]!.id;
  c.release("a");
  await Promise.resolve();
  c.retain("a");
  const current = c.get("a")!;
  assert.equal(current.messages[0]!.id, 41);
  const obsolete = { messages: all.messages.slice(0, 20), hasMore: false };
  assert.equal(prependChatPage(current, before, obsolete), current, "discard a page requested for a different first message");
  const adjacent = { messages: all.messages.slice(20, 40), hasMore: true };
  const next = prependChatPage(current, 41, adjacent)!;
  assert.deepEqual(
    next.messages.map((m) => m.id),
    all.messages.slice(20).map((m) => m.id),
  );
  assert.equal(next.hasMore, true);
  assert.equal(prependChatPage(undefined, before, obsolete), undefined, "an evicted Chat is not resurrected by an old request");
});

test("subscription handoff protects expanded history from trimming and cache pressure", async () => {
  const c = cache(10);
  c.retain("a");
  const all = page(100);
  c.set("a", all);
  c.release("a");
  c.set("a", all);
  c.set("b", page(2));
  c.retain("a");
  await Promise.resolve();
  assert.equal(c.get("a"), all);
  c.release("a");
  await Promise.resolve();
  assert.equal(c.has("a"), false, "a true final release still enforces the byte budget");
});

test("a read window followed for long trims back to its last turns, only once it holds twice as many", () => {
  const c = cache();
  c.retain("a");
  c.set("a", page(8));
  assert.equal(c.trim("a"), null, "four turns is within twice the two kept");
  assert.equal(c.get("a")!.messages.length, 8);
  const all = page(12);
  c.set("a", all);
  const trimmed = c.trim("a")!;
  assert.deepEqual(
    trimmed.messages.map((m) => m.id),
    [8, 9, 10, 11],
  );
  assert.equal(trimmed.hasMore, true, "the dropped turns can be read again");
  assert.equal(trimmed.total, 12);
  assert.equal(c.get("a"), trimmed);
  assert.equal(c.trim("missing"), null);
});
