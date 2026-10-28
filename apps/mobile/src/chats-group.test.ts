import { test } from "node:test";
import assert from "node:assert/strict";
import { chatsGroupChats, chatsGroupList, chatsGroupNeedsAttention, chatsRowDetail } from "./chats-group.ts";

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

test("the Chats group header marks a Chat waiting in the open computer's home, folded or not", () => {
  const homes = [
    { hostId: "mac", path: "/Users/me/.milagre/chats" },
    { hostId: "studio", path: "/Users/ana/.milagre/chats" },
  ];
  assert.equal(chatsGroupNeedsAttention(homes, "mac", ["/Users/me/.milagre/chats"]), true);
  // A Project's Chat waiting marks that Project, not the Chats group.
  assert.equal(chatsGroupNeedsAttention(homes, "mac", ["/code/shop"]), false);
  // Attention keys are the open computer's: another computer's home at the same path isn't marked.
  assert.equal(chatsGroupNeedsAttention(homes, "studio", ["/Users/me/.milagre/chats"]), false);
  assert.equal(chatsGroupNeedsAttention([], "mac", ["/Users/me/.milagre/chats"]), false);
});

test("the Chats group always shows once a computer is listed, with no Chats and no Chats home yet", () => {
  // No home on any computer yet: the header still shows, for its + (which makes this computer's home).
  assert.deepEqual(chatsGroupList({ computers: 1, rows: [], folded: false, homes: [] }), {
    header: { kind: "chatsGroup", expanded: true, count: 0, offline: false, homes: [] },
    rows: [],
  });
  const rows = [
    { reach: "online", name: "regex" },
    { reach: "offline", name: "port" },
  ];
  const homes = [{ hostId: "mac", path: "/Users/me/.milagre/chats" }];
  assert.deepEqual(chatsGroupList({ computers: 2, rows, folded: false, homes })?.rows, rows);
  // Folded: the header counts them, the rows go.
  const folded = chatsGroupList({ computers: 2, rows, folded: true, homes });
  assert.deepEqual(folded?.rows, []);
  assert.equal(folded?.header.count, 2);
  assert.equal(folded?.header.offline, false);
  assert.equal(chatsGroupList({ computers: 2, rows: [{ reach: "offline" }], folded: false, homes })?.header.offline, true);
  // Nothing paired or shown: no computer to start a Chat on, so the drawer says how to pair instead.
  assert.equal(chatsGroupList({ computers: 0, rows: [], folded: false, homes: [] }), null);
});
