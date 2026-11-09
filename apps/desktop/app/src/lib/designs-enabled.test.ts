import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { MilagreBridge } from "../electron.d.ts";

(globalThis as { window?: unknown }).window = { milagre: {} };
const { designsEnabledStore } = await import("./designs-enabled.ts");

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A host whose reads answer in turn: an Error rejects, a boolean answers. */
function bridge(answers: (boolean | Error)[]) {
  const reads: number[] = [];
  const fake = {
    readDesignsEnabled: async () => {
      reads.push(Date.now());
      const answer = answers.shift() ?? true;
      if (answer instanceof Error) throw answer;
      return { enabled: answer };
    },
    onDesignsEnabledChanged: () => () => {},
  } as unknown as MilagreBridge;
  return { fake, reads };
}

test("a read the host rejects is asked again until it answers, not left as Designs off", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // The desktop client rejects a call at once past 32 pending requests, which a busy Mac reaches while a Chat loads.
    const { fake, reads } = bridge([new Error("Too many pending daemon requests"), new Error("Too many pending daemon requests"), true]);
    const store = designsEnabledStore(fake);
    const stop = store.subscribe(() => {});
    await settle();
    assert.equal(store.snapshot().enabled, false);
    assert.equal(store.snapshot().error, "Could not read the Designs setting.");
    for (let i = 0; i < 2; i++) {
      mock.timers.tick(10_000);
      await settle();
    }
    assert.equal(reads.length, 3);
    assert.deepEqual({ enabled: store.snapshot().enabled, error: store.snapshot().error }, { enabled: true, error: "" });
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("a Chat view mounting again within a minute takes the last answer without asking the host", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { fake, reads } = bridge([false]);
    const store = designsEnabledStore(fake);
    const first = store.subscribe(() => {});
    await settle();
    first();
    mock.timers.tick(30_000);
    const second = store.subscribe(() => {});
    await settle();
    assert.equal(reads.length, 1, "a switch back reads nothing again");
    assert.equal(store.snapshot().enabled, false);
    second();
  } finally {
    mock.timers.reset();
  }
});

test("a Chat view mounting again keeps the last answer while a failed read retries", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { fake, reads } = bridge([true, new Error("Timed out: designs:enabled:read"), true]);
    const store = designsEnabledStore(fake);
    const first = store.subscribe(() => {});
    await settle();
    assert.equal(store.snapshot().enabled, true);
    // Switching Projects unmounts every reader, then mounts the next Chat's, once the last answer is a minute old.
    first();
    mock.timers.tick(60_000);
    const second = store.subscribe(() => {});
    await settle();
    assert.equal(store.snapshot().enabled, true, "the cards stay while the host is slow");
    mock.timers.tick(10_000);
    await settle();
    assert.equal(reads.length, 3);
    assert.equal(store.snapshot().error, "");
    second();
  } finally {
    mock.timers.reset();
  }
});

test("no retry runs once the last reader is gone", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { fake, reads } = bridge([new Error("Milagre host is disconnected. Your command was not sent.")]);
    const store = designsEnabledStore(fake);
    const stop = store.subscribe(() => {});
    await settle();
    stop();
    mock.timers.tick(60_000);
    await settle();
    assert.equal(reads.length, 1);
  } finally {
    mock.timers.reset();
  }
});
