import { test } from "node:test";
import assert from "node:assert/strict";
import { chatsGroupChats, chatsRowDetail } from "./chats-group.ts";

const entry = (name: string, firstAt: number, extra: { pinned?: boolean; pin_order?: number } = {}) => ({ name, chat: { ...extra, summary: { firstAt } } });

test("the drawer's Chats group merges every computer's home Chats newest first", () => {
  const merged = chatsGroupChats([
    { hostId: "santo", chats: [entry("regex", 300), entry("port", 100)] },
    { hostId: "studio", chats: [] },
    { hostId: "arketa", chats: [entry("invoice", 200)] },
  ]);
  assert.deepEqual(
    merged.map(({ hostId, entry }) => `${hostId}:${entry.name}`),
    ["santo:regex", "arketa:invoice", "santo:port"],
  );
  // Pinned Chats lead, in their pin order, whichever computer they are on.
  const pinned = chatsGroupChats([
    { hostId: "santo", chats: [entry("pin-2", 1, { pinned: true, pin_order: 2 }), entry("new", 900)] },
    { hostId: "arketa", chats: [entry("pin-1", 1, { pinned: true, pin_order: 1 })] },
  ]);
  assert.deepEqual(
    pinned.map(({ entry }) => entry.name),
    ["pin-1", "pin-2", "new"],
  );
  assert.deepEqual(chatsGroupChats([]), []);
});

test("a Chats group row names its computer and its age, never a branch", () => {
  const now = 10 * 24 * 3_600_000;
  assert.equal(chatsRowDetail("Santo", now - 2 * 60_000, now), "Santo · 2m");
  assert.equal(chatsRowDetail("Santo", undefined, now), "Santo");
});
