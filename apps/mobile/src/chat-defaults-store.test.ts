import assert from "node:assert/strict";
import test from "node:test";
import { createChatDefaultsStore } from "./chat-defaults-store.ts";

test("new Chat choices survive a fresh store, scoped by computer and Project, without Linear", async () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const first = createChatDefaultsStore(storage);
  await first.saveTarget("mac", "/a", { isolation: "worktree", baseBranch: "release", linearIssue: "ENG-1" } as never);
  await first.saveModel({ provider: "claude", model: "opus", effort: "high", fastMode: true, pickedOn: "codex", linearIssue: "ENG-1" } as never);
  const reopened = createChatDefaultsStore(storage);
  assert.deepEqual(reopened.readTarget("mac", "/a"), { isolation: "worktree", baseBranch: "release" });
  assert.deepEqual(reopened.readTarget("other-mac", "/a"), { isolation: "worktree" });
  assert.deepEqual(reopened.readTarget("mac", "/b"), { isolation: "worktree" });
  assert.deepEqual(reopened.readModel(), { provider: "claude", model: "opus", effort: "high", fastMode: true, ultracode: false });
  assert.ok([...data.values()].every((value) => !value.includes("ENG-1") && !value.includes("pickedOn")));
});

test("immediate reads keep the latest pick while writes are pending", async () => {
  const data = new Map<string, string>();
  const store = createChatDefaultsStore({
    getItem: (key) => data.get(key) ?? null,
    setItemAsync: async (key, value) => {
      data.set(key, value);
    },
  });
  const saving = store.saveTarget("mac", "/a", { isolation: "worktree" });
  const latest = store.saveTarget("mac", "/a", { baseBranch: "release" });
  assert.deepEqual(store.readTarget("mac", "/a"), { isolation: "worktree", baseBranch: "release" });
  await Promise.all([saving, latest]);
  assert.deepEqual(createChatDefaultsStore({ getItem: (key) => data.get(key) ?? null, setItemAsync: async () => {} }).readTarget("mac", "/a"), {
    isolation: "worktree",
    baseBranch: "release",
  });
});

test("corrupt or unavailable storage falls back without blocking new Chats", async () => {
  for (const getItem of [
    () => "null",
    () => "{",
    () => '{"provider":"unknown"}',
    () => {
      throw new Error("locked");
    },
  ]) {
    const store = createChatDefaultsStore({
      getItem,
      setItemAsync: async () => {
        throw new Error("locked");
      },
    });
    assert.equal(store.readModel(), null);
    assert.deepEqual(store.readTarget("mac", "/a"), { isolation: "local" });
    await store.saveTarget("mac", "/a", { isolation: "worktree" });
    assert.deepEqual(store.readTarget("mac", "/a"), { isolation: "worktree" });
  }
});

test("the last new Chat's Project survives a fresh store", async () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const first = createChatDefaultsStore(storage);
  assert.equal(first.readLastProject(), null);
  await first.saveLastProject("mac", "/a");
  await first.saveLastProject("other-mac", "/b");
  assert.deepEqual(createChatDefaultsStore(storage).readLastProject(), { hostId: "other-mac", projectPath: "/b" });
  data.set("milagre.chat-last-project.v1", '{"hostId":1}');
  assert.equal(createChatDefaultsStore(storage).readLastProject(), null);
});
