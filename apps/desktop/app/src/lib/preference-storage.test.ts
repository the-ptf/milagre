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
  assert.equal(old.getItem(key), '{"theme":"light"}');
  updated.removeItem(key);
  assert.equal(old.getItem(key), null, "stale localStorage must not resurrect a deletion");
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
