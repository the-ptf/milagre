import assert from "node:assert/strict";
import test from "node:test";
import { askKeepAwake, createKeepAwakeNeverAsk, KEEP_AWAKE_FAILED_TITLE, KEEP_AWAKE_TITLE } from "./keep-awake-ask.ts";

function memory() {
  const items = new Map<string, string>();
  return { getItemAsync: async (key: string) => items.get(key) ?? null, setItemAsync: async (key: string, value: string) => void items.set(key, value) };
}

type Button = { text: string; onPress?: () => void };

function fixture(read: () => Promise<unknown>, save: () => Promise<unknown> = async () => ({ enabled: true })) {
  const calls: [string, unknown[] | undefined][] = [];
  const client = {
    call: async <T>(method: string, args?: unknown[]) => {
      calls.push([method, args]);
      return (await (method === "keep-awake:settings:read" ? read() : save())) as T;
    },
  };
  const asked: string[][] = [];
  // The answers to give, one per sheet, in order; "Not now" once they run out.
  let picks: string[] = [];
  const ask = (title: string, _message: string | undefined, buttons: Button[]) => {
    asked.push([title, ...buttons.map((button) => button.text)]);
    const pick = picks.shift() ?? "Not now";
    buttons.find((button) => button.text === pick)?.onPress?.();
  };
  const neverAsk = createKeepAwakeNeverAsk(memory());
  const run = (answers: string | string[], { hostId = "https://mac.local", isCurrent }: { hostId?: string; isCurrent?: () => boolean } = {}) => {
    picks = Array.isArray(answers) ? answers : [answers];
    return askKeepAwake({ client, hostId, neverAsk, ask, isCurrent });
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
  await f.run("Not now", { hostId: "https://other.local" });
  assert.equal(f.asked.length, 2, "another Mac is still asked");
});

test("a Mac that can't say is never asked", async () => {
  const refused = fixture(async () => {
    throw new Error("Command is not available from mobile");
  });
  await refused.run("Keep awake");
  assert.equal(refused.asked.length, 0);
  for (const answer of [null, {}, { enabled: "no" }]) {
    const f = fixture(async () => answer);
    await f.run("Keep awake");
    assert.equal(f.asked.length, 0, `${JSON.stringify(answer)} is no answer`);
  }
});

test("a read that answers after the Chat changed shows nothing and saves nothing", async () => {
  let current = true;
  let answer: (value: unknown) => void = () => {};
  const f = fixture(() => new Promise((resolve) => (answer = resolve)));
  const asking = f.run("Keep awake", { isCurrent: () => current });
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  answer({ enabled: false });
  await asking;
  assert.equal(f.asked.length, 0);
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ["keep-awake:settings:read"],
  );
});

test("a failed save says why and Try again saves again", async () => {
  let failures = 1;
  const f = fixture(
    async () => ({ enabled: false }),
    async () => {
      if (failures-- > 0) throw new Error("The Mac went offline.");
      return { enabled: true };
    },
  );
  await f.run(["Keep awake", "Try again"]);
  assert.deepEqual(f.asked[1], [KEEP_AWAKE_FAILED_TITLE, "Try again", "Not now"]);
  assert.equal(f.calls.filter(([method]) => method === "keep-awake:settings:save").length, 2);
  assert.equal(f.asked.length, 2, "the second save went through");
});

test("two Chats of one Mac on screen together ask once; a Chat left behind doesn't hold up the next", async () => {
  const answers: ((value: unknown) => void)[] = [];
  const f = fixture(() => new Promise((resolve) => answers.push(resolve)));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  let firstCurrent = true;
  const first = f.run("Not now", { isCurrent: () => firstCurrent });
  await f.run("Not now");
  await settle();
  assert.equal(f.calls.length, 1, "the pane beside on the same Mac doesn't read again");
  firstCurrent = false;
  const third = f.run("Not now");
  await settle();
  assert.equal(f.calls.length, 2, "the Chat opened after the first was left asks for itself");
  for (const answer of answers) answer({ enabled: false });
  await Promise.all([first, third]);
  assert.equal(f.asked.length, 1, "only the Chat still on screen is asked");
});
