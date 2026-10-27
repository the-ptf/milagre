import assert from "node:assert/strict";
import test from "node:test";
import { readWithTimeout } from "./read-timeout.mjs";

test("a stalled read times out, a retry succeeds, and a late answer cannot replace it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const first = readWithTimeout(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const failed = assert.rejects(first, /read took too long/);
  await Promise.resolve();
  t.mock.timers.tick(15_000);
  await failed;
  assert.equal(await readWithTimeout(async () => "retry"), "retry");
  finish("late");
  await assert.rejects(first, /read took too long/);
});

test("successful, rejected and synchronously failing reads settle without waiting for the timeout", async () => {
  assert.equal(await readWithTimeout(async () => 42), 42);
  await assert.rejects(
    readWithTimeout(async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  await assert.rejects(
    readWithTimeout(() => {
      throw new Error("unavailable");
    }),
    /unavailable/,
  );
});
