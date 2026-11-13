import assert from "node:assert/strict";
import test from "node:test";
import { createPreferenceStorage, type PreferenceBridge } from "./preference-storage.ts";

function local(values = new Map<string, string>()) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}
function native(): PreferenceBridge {
  const values = new Map<string, string | null>();
  return {
    get: (key) => ({ value: values.get(key) }),
    set: (key, value) => {
      values.set(key, value);
      return {};
    },
  };
}

test("migrates legacy settings and restores them with an empty origin after update", () => {
  const bridge = native();
  const key = "milagre-settings";
  const saved = '{"theme":"dark","colorTheme":"nord","expandReasoning":true}';
  const old = createPreferenceStorage(
    () => local(new Map([[key, saved]])),
    () => bridge,
  );
  assert.equal(old.getItem(key), saved);
  const updated = createPreferenceStorage(
    () => local(),
    () => bridge,
  );
  assert.equal(updated.getItem(key), saved);
  updated.setItem(key, '{"theme":"light"}');
  // The main process tells every other window (preferences:changed), which reads the key again.
  old.forget(key);
  assert.equal(old.getItem(key), '{"theme":"light"}');
  updated.removeItem(key);
  old.forget(key);
  assert.equal(old.getItem(key), null, "stale localStorage must not resurrect a deletion");
  // A fresh window reads the native copy, not the stale localStorage one.
  const restarted = createPreferenceStorage(
    () => local(new Map([[key, saved]])),
    () => bridge,
  );
  assert.equal(restarted.getItem(key), null, "stale localStorage must not resurrect a deletion");
});

test("a preference is read from the main process once, then kept current by writes and read again after a change elsewhere", () => {
  const values = new Map<string, string | null>([["milagre-settings", "first"]]);
  let reads = 0;
  const bridge: PreferenceBridge = {
    get: (key) => {
      reads++;
      return { value: values.get(key) };
    },
    set: (key, value) => {
      values.set(key, value);
      return {};
    },
  };
  const storage = createPreferenceStorage(
    () => local(),
    () => bridge,
  );
  for (let i = 0; i < 5; i++) assert.equal(storage.getItem("milagre-settings"), "first");
  assert.equal(reads, 1, "every render reading a preference must not cost a synchronous IPC");
  storage.setItem("milagre-settings", "second");
  assert.equal(storage.getItem("milagre-settings"), "second");
  storage.removeItem("milagre-settings");
  assert.equal(storage.getItem("milagre-settings"), null);
  assert.equal(reads, 1);
  // A write the window didn't make itself (a storage event) is read again.
  values.set("milagre-settings", "written elsewhere");
  storage.forget("milagre-settings");
  assert.equal(storage.getItem("milagre-settings"), "written elsewhere");
  assert.equal(reads, 2);
  // A failed read is never kept.
  const failing = createPreferenceStorage(
    () => local(),
    () => ({ get: () => ({ error: "Busy" }), set: () => ({}) }),
  );
  assert.throws(() => failing.getItem("milagre-settings"), /Busy/);
  assert.throws(() => failing.getItem("milagre-settings"), /Busy/);
});

test("native saving works even when Chromium storage is unavailable", () => {
  const bridge = native();
  const storage = createPreferenceStorage(
    () => {
      throw new Error("Storage blocked");
    },
    () => bridge,
  );
  storage.setItem("milagre-settings", "saved");
  assert.equal(storage.getItem("milagre-settings"), "saved");
  storage.removeItem("milagre-settings");
  assert.equal(storage.getItem("milagre-settings"), null);
});

test("browser fixtures keep using localStorage and native write failures are reported", () => {
  const memory = local();
  const storage = createPreferenceStorage(
    () => memory,
    () => undefined,
  );
  storage.setItem("milagre-settings", "saved");
  assert.equal(storage.getItem("milagre-settings"), "saved");
  const failed = createPreferenceStorage(
    () => memory,
    () => ({ get: () => ({}), set: () => ({ error: "Disk full" }) }),
  );
  assert.throws(() => failed.setItem("milagre-settings", "lost"), /Disk full/);
  assert.equal(memory.getItem("milagre-settings"), "saved");
});
