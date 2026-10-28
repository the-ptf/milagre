import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderUpdateDismissals } from "./provider-update-dismissals.ts";

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

test("dismissed provider releases are kept per computer, without the computer's address", async () => {
  const store = storage();
  const dismissals = createProviderUpdateDismissals(store);
  await dismissals.add("https://studio.local:7788", "codex:0.165.0");
  await dismissals.add("https://studio.local:7788", "codex:0.165.0");
  await dismissals.add("https://relay.milagre.cloud/h/other", "claude:2.1.312");
  assert.deepEqual(await dismissals.load("https://studio.local:7788"), ["codex:0.165.0"]);
  assert.deepEqual(await createProviderUpdateDismissals(store).load("https://relay.milagre.cloud/h/other"), ["claude:2.1.312"]);
  assert.ok(![...store.values.values()].some((value) => value.includes("studio.local")));
});

test("only the newest dismissals are kept, and unreadable saved values read as none", async () => {
  const store = storage();
  const dismissals = createProviderUpdateDismissals(store);
  for (let i = 0; i < 45; i++) await dismissals.add("host", `codex:0.${i}.0`);
  const kept = await dismissals.load("host");
  assert.equal(kept.length, 40);
  assert.equal(kept.at(-1), "codex:0.44.0");
  store.values.set("milagre.provider-update-dismissals.v1", "{not json");
  assert.deepEqual(await dismissals.load("host"), []);
});
