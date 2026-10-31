import test from "node:test";
import assert from "node:assert/strict";
import { observeComputerUseScreen, type ComputerUseFrame } from "./computer-use.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("desktop and phone observation survives initial idle, a single delayed tool and its final frame", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const frames: ComputerUseFrame[] = [];
  const reads: number[] = [];
  let current: ComputerUseFrame = { seq: 0, live: false };
  const stop = observeComputerUseScreen(
    async (after) => (reads.push(after), current),
    (frame) => frames.push(frame),
  );
  t.after(stop);
  await flush();
  assert.equal(reads.length, 1);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(reads.length, 1, "older hosts' immediate idle answers are throttled");
  t.mock.timers.tick(1);
  await flush();
  current = { seq: 1, live: true, image: "FIRST" };
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(frames.at(-1)?.image, "FIRST", "no second tool or remount is needed");
  current = { ...current, live: false };
  t.mock.timers.tick(0);
  await flush();
  assert.equal(frames.at(-1)?.live, false, "final frame updates even when its sequence is unchanged");
  stop();
  const count = reads.length;
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(reads.length, count);
});

test("reconnect retries a failed read with a reset cursor and unmount ignores a pending reply", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reads: number[] = [];
  const frames: ComputerUseFrame[] = [];
  let finish: (value: ComputerUseFrame) => void = () => {};
  const stop = observeComputerUseScreen(
    async (after) => {
      reads.push(after);
      if (reads.length === 1) return { seq: 8, image: "BEFORE", live: true };
      if (reads.length === 2) throw new Error("Connection lost");
      if (reads.length === 3) return { seq: 1, image: "RESTARTED", live: true };
      return new Promise((resolve) => (finish = resolve));
    },
    (frame) => frames.push(frame),
  );
  t.after(stop);
  await flush();
  t.mock.timers.tick(0);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(reads, [0, 8, 0]);
  assert.equal(frames.at(-1)?.image, "RESTARTED");
  t.mock.timers.tick(0);
  await flush();
  stop();
  finish({ seq: 2, image: "STALE", live: true });
  await flush();
  assert.equal(frames.at(-1)?.image, "RESTARTED");
});

test("an idle feed stops observing once the card's steps are done, so old cards don't hold requests open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reads: number[] = [];
  let active = true;
  const stop = observeComputerUseScreen(
    async (after) => (reads.push(after), { seq: 3, live: false, image: "LAST" }),
    () => {},
    () => active,
  );
  t.after(stop);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(reads.length, 2, "still waiting for capture while the steps run");
  active = false;
  t.mock.timers.tick(1000);
  await flush();
  const count = reads.length;
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(reads.length, count, "no more reads once idle and done");
});
