import { test } from "node:test";
import assert from "node:assert/strict";
import { CURRENT_EVERY, FAILURE_CAP, OFFLINE_EVERY, OTHER_EVERY, createLimiter, jitter, nextDelay } from "./all-computers-schedule.ts";

test("a read comes within 20% of its cadence, doubling and capping once a computer fails", () => {
  assert.equal(
    jitter(1000, () => 0),
    800,
  );
  assert.equal(
    jitter(1000, () => 1),
    1200,
  );
  const mid = () => 0.5;
  assert.equal(nextDelay({ current: true, failures: 0, random: mid }), CURRENT_EVERY);
  assert.equal(nextDelay({ current: false, failures: 0, random: mid }), OTHER_EVERY);
  assert.equal(nextDelay({ current: false, failures: 1, random: mid }), OTHER_EVERY * 2);
  assert.equal(nextDelay({ current: false, failures: 2, random: mid }), OFFLINE_EVERY);
  assert.equal(nextDelay({ current: true, failures: 2, random: mid }), OFFLINE_EVERY);
  assert.equal(nextDelay({ current: false, failures: 3, random: mid }), OFFLINE_EVERY * 2);
  assert.equal(nextDelay({ current: false, failures: 20, random: mid }), FAILURE_CAP);
  for (const failures of [0, 1, 2, 5]) {
    const low = nextDelay({ current: false, failures, random: () => 0 });
    const high = nextDelay({ current: false, failures, random: () => 1 });
    assert.ok(high / low > 1.4 && high / low < 1.6);
  }
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("the limiter counts requests by weight and starts jobs in order", async () => {
  const limiter = createLimiter(3);
  const gates = [gate(), gate(), gate(), gate()];
  const started: string[] = [];
  const job = (name: string, weight: number, at: number) =>
    limiter.run(weight, async () => {
      started.push(name);
      await gates[at]!.promise;
      return name;
    });
  const results = [job("list", 3, 0), job("one", 1, 1), job("two", 1, 2), job("three", 1, 3)];
  assert.deepEqual(started, ["list"]);
  assert.equal(limiter.inFlight, 3);
  assert.equal(limiter.queued, 3);
  gates[0]!.open();
  await results[0];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["list", "one", "two", "three"]);
  assert.equal(limiter.inFlight, 3);
  gates[1]!.open();
  gates[2]!.open();
  gates[3]!.open();
  assert.deepEqual(await Promise.all(results), ["list", "one", "two", "three"]);
  assert.equal(limiter.inFlight, 0);
});

test("a failing job frees its slots, and a job heavier than the cap still runs", async () => {
  const limiter = createLimiter(2);
  await assert.rejects(
    limiter.run(1, async () => {
      throw new Error("lost");
    }),
    /lost/,
  );
  assert.equal(limiter.inFlight, 0);
  assert.equal(await limiter.run(9, async () => "ran"), "ran");
});
