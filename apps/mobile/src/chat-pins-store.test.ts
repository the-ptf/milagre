import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedPins, createChatPinsStore } from "./chat-pins-store.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const sessions = [{ id: 1, pinned: true, pin_order: 0 }, { id: 2 }, { id: 3 }];

test("nothing is pinned on the phone until a Chat is pinned here", async () => {
  const store = createChatPinsStore(storage());
  assert.deepEqual(store.pins("relay://mac"), {});
  await store.load("relay://mac");
  assert.deepEqual(store.pins("relay://mac"), {});
});

test("a pin copies the Project's shared pins, then survives a relaunch, per computer", async () => {
  const disk = storage();
  const first = createChatPinsStore(disk);
  const before = first.version();
  await first.set("relay://mac", "/code/a", sessions, 2, 1);
  assert.ok(first.version() > before);
  assert.deepEqual(first.pins("relay://mac"), { "/code/a": { 1: 0, 2: 1 } });
  await first.set("relay://mac", "/code/a", sessions, 1, null);
  const second = createChatPinsStore(disk);
  await second.load("relay://mac");
  assert.deepEqual(second.pins("relay://mac"), { "/code/a": { 2: 1 } });
  await second.load("relay://other");
  assert.deepEqual(second.pins("relay://other"), {}, "Another computer's Chats keep their own pins");
});

test("a pin made before the saved pins are read keeps them", async () => {
  const disk = storage();
  const first = createChatPinsStore(disk);
  await first.set("relay://mac", "/code/a", sessions, 3, 5);
  const second = createChatPinsStore(disk);
  await second.set("relay://mac", "/code/b", [{ id: 7 }], 7, 0);
  assert.deepEqual(second.pins("relay://mac"), { "/code/a": { 1: 0, 3: 5 }, "/code/b": { 7: 0 } });
});

test("the saved pins fit a SecureStore value: the Projects pinned in longest ago go first", () => {
  const long = (n: number) => `/Users/someone/Code/${"x".repeat(80)}/${n}`;
  const pins = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [long(n), { 1: 0, 2: 1 }]));
  const kept = boundedPins("relay://mac", pins);
  assert.ok(JSON.stringify({ h: "relay://mac", p: kept }).length <= 1900);
  assert.ok(Object.keys(kept).length < 40);
  assert.equal(Object.keys(kept).at(-1), long(39));
  assert.equal(Object.hasOwn(kept, long(0)), false);
});
