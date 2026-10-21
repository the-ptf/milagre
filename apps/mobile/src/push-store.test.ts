import test from "node:test";
import assert from "node:assert/strict";
import { createPushStore } from "./push-store.ts";
import type { SavedHost } from "./hosts-store.ts";
const deviceId = "b6e2df4b-972b-4e7b-bc65-6cda0a173798";
const host: SavedHost = { id: "https://mac.example", address: "https://mac.example", name: "Mac", token: "a".repeat(64), lastUsed: 0 };
function driver() {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("installation identity and opt-in preferences survive restart in secure storage", async () => {
  const storage = driver();
  const store = createPushStore(storage, () => deviceId);
  assert.deepEqual(await store.read(), {
    deviceId,
    enabled: false,
    notifyWhenWaiting: true,
    notifyOnCompletion: true,
    token: null,
    registered: [],
    pending: [],
  });
  await store.update({ enabled: true, token: "ExpoPushToken[one]", notifyOnCompletion: false });
  const other = createPushStore(storage, () => "different");
  assert.equal((await other.read()).deviceId, deviceId);
  assert.equal((await other.read()).enabled, true);
  assert.equal((await other.read()).notifyOnCompletion, false);
});

test("forget keeps a private unregister tombstone and success removes its credentials", async () => {
  const storage = driver();
  const store = createPushStore(storage, () => deviceId);
  await store.registered(host);
  await store.forget(host);
  const state = await store.read();
  assert.deepEqual(state.registered, []);
  assert.deepEqual(state.pending, [{ ...host, forgotten: true }]);
  await store.unregistered(host);
  assert.deepEqual((await store.read()).pending, []);
  assert.ok(![...storage.values.values()].join().includes(host.token));
});

test("disabling moves all registered computers into the retry queue atomically", async () => {
  const store = createPushStore(driver(), () => deviceId);
  await store.update({ enabled: true, token: "ExpoPushToken[one]" });
  await store.registered(host);
  await store.disable();
  const state = await store.read();
  assert.equal(state.enabled, false);
  assert.deepEqual(state.registered, []);
  assert.deepEqual(state.pending, [host]);
});

test("late secure writes complete before disable and a failed write preserves the prior state", async () => {
  const storage = driver();
  let fail = false;
  const store = createPushStore(
    {
      ...storage,
      setItemAsync: async (key, value) => {
        if (fail) throw new Error("storage");
        await storage.setItemAsync(key, value);
      },
    },
    () => deviceId,
  );
  await store.read();
  const enabling = store.update({ enabled: true });
  const disabling = store.disable();
  await Promise.all([enabling, disabling]);
  assert.equal((await store.read()).enabled, false);
  fail = true;
  await assert.rejects(store.update({ enabled: true }), /storage/);
  assert.equal((await store.read()).enabled, false);
});

test("a phone's schedule survives restart and anytime clears it", async () => {
  const storage = driver();
  const schedule = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timeZone: "America/Toronto" };
  const store = createPushStore(storage, () => deviceId);
  await store.update({ schedule });
  const restarted = createPushStore(storage, () => "unused");
  assert.deepEqual((await restarted.read()).schedule, schedule);
  await restarted.update({ schedule: null });
  assert.equal((await createPushStore(storage, () => "unused").read()).schedule, null);
});
