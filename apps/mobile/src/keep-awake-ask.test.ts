import assert from "node:assert/strict";
import test from "node:test";
import { askKeepAwake, createKeepAwakeNeverAsk, KEEP_AWAKE_TITLE } from "./keep-awake-ask.ts";

function memory() {
  const items = new Map<string, string>();
  return { getItemAsync: async (key: string) => items.get(key) ?? null, setItemAsync: async (key: string, value: string) => void items.set(key, value) };
}

function fixture(read: () => Promise<unknown>) {
  const calls: [string, unknown[] | undefined][] = [];
  const client = {
    call: async <T>(method: string, args?: unknown[]) => {
      calls.push([method, args]);
      return (method === "keep-awake:settings:read" ? await read() : { enabled: true }) as T;
    },
  };
  const asked: string[][] = [];
  let pick = "Not now";
  const ask = (title: string, _message: string | undefined, buttons: { text: string; onPress?: () => void }[]) => {
    asked.push([title, ...buttons.map((button) => button.text)]);
    buttons.find((button) => button.text === pick)?.onPress?.();
  };
  const neverAsk = createKeepAwakeNeverAsk(memory());
  const run = (answer: string, hostId = "https://mac.local") => {
    pick = answer;
    return askKeepAwake({ client, hostId, neverAsk, ask });
  };
  return { calls, asked, run };
}

test("a Mac that sleeps is asked about on every Chat until Keep awake turns it on", async () => {
  let enabled = false;
  const f = fixture(async () => ({ enabled }));
  await f.run("Not now");
  await f.run("Not now");
  assert.equal(f.asked.length, 2);
  assert.deepEqual(f.asked[0], [KEEP_AWAKE_TITLE, "Keep awake", "Don't ask again", "Not now"]);
  await f.run("Keep awake");
  assert.deepEqual(f.calls.at(-1), ["keep-awake:settings:save", [{ enabled: true }]]);
  enabled = true;
  await f.run("Not now");
  assert.equal(f.asked.length, 3, "an awake Mac isn't asked about");
});

test("Don't ask again holds for that Mac only", async () => {
  const f = fixture(async () => ({ enabled: false }));
  await f.run("Don't ask again");
  await f.run("Not now");
  assert.equal(f.asked.length, 1);
  await f.run("Not now", "https://other.local");
  assert.equal(f.asked.length, 2, "another Mac is still asked");
});

test("a Mac that can't say is never asked", async () => {
  const f = fixture(async () => {
    throw new Error("Command is not available from mobile");
  });
  await f.run("Keep awake");
  assert.equal(f.asked.length, 0);
});
