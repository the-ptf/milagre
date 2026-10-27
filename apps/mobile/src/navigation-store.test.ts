import { test } from "node:test";
import assert from "node:assert/strict";
import { createNavigationStore, parseLocation } from "./navigation-store.ts";

test("a saved Chat is identified by computer, Project and Chat together", async () => {
  let value: string | null = null;
  const store = createNavigationStore({
    getItemAsync: async () => value,
    setItemAsync: async (_, next) => {
      value = next;
    },
  });
  const target = { hostId: "relay://mac", projectPath: "/Code/project", chatId: 3 };
  await store.save(target);
  assert.deepEqual(await store.read(), target);
  await store.save({ ...target, hostId: "relay://studio", projectPath: "/Code/other" });
  assert.deepEqual(await store.read(), { ...target, hostId: "relay://studio", projectPath: "/Code/other" });
});

test("corrupt or incomplete saved targets never restore an arbitrary Chat", () => {
  for (const value of [
    null,
    "",
    "{",
    "{}",
    '{"hostId":"mac","chatId":1}',
    '{"hostId":"mac","projectPath":"/p","chatId":-1}',
    '{"hostId":"mac","projectPath":"/p","chatId":"1"}',
  ]) {
    assert.equal(parseLocation(value), null);
  }
});

test("rapid Chat switches persist in order even with slow storage", async () => {
  let value = "";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const store = createNavigationStore({
    getItemAsync: async () => value,
    setItemAsync: async (_, next) => {
      if (++calls === 1) await gate;
      value = next;
    },
  });
  const a = store.save({ hostId: "mac", projectPath: "/p", chatId: 1 });
  const b = store.save({ hostId: "mac", projectPath: "/p", chatId: 2 });
  release();
  await Promise.all([a, b]);
  assert.equal((await store.read())?.chatId, 2);
});

test("a locked keychain does not prevent navigation", async () => {
  const store = createNavigationStore({
    getItemAsync: async () => {
      throw new Error("locked");
    },
    setItemAsync: async () => {
      throw new Error("locked");
    },
  });
  assert.equal(await store.read(), null);
  await store.save({ hostId: "mac", projectPath: "/p", chatId: 1 });
});

test("removing a Project clears only its saved Chat after pending saves", async () => {
  let value = "";
  const store = createNavigationStore({
    getItemAsync: async () => value,
    setItemAsync: async (_, next) => {
      value = next;
    },
  });
  const location = { hostId: "mac", projectPath: "/p", chatId: 1 };
  void store.save(location);
  await store.forgetProject("studio", "/p");
  assert.deepEqual(await store.read(), location);
  await store.forgetProject("mac", "/other");
  assert.deepEqual(await store.read(), location);
  await store.forgetProject("mac", "/p");
  assert.equal(await store.read(), null);
});
