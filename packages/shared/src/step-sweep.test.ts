import assert from "node:assert/strict";
import test from "node:test";
import { SWEEP_MS, createStepSweepWindow, sweepRemainingMs } from "./step-sweep.ts";

test("a step's sweep budget follows its host timestamp, including remounts and approval waits", () => {
  for (const age of [0, 600, 1700, 2399, 2400, 3000]) {
    assert.equal(sweepRemainingMs(10_000, 10_000 + age), Math.max(0, SWEEP_MS - age));
  }
  assert.equal(sweepRemainingMs(20_000, 20_000), SWEEP_MS, "a new step has its own budget");
});

test("old hosts, invalid timestamps and future host clocks never start a sweep", () => {
  for (const start of [undefined, NaN, Infinity, -1, 0, 10_001]) assert.equal(sweepRemainingMs(start, 10_000), 0);
});

test("snapshots keep their phase through rerenders, settle once and never restart after clock corrections", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const window = createStepSweepWindow(10_000, true);
  let calls = 0;
  const stop = window.subscribe(() => calls++);
  t.mock.timers.tick(600);
  now += 600;
  assert.equal(window.getSnapshot(), SWEEP_MS, "ordinary renders do not shift the negative delay");
  assert.equal(createStepSweepWindow(10_000, true).getSnapshot(), 1800, "remount resumes the remaining budget");
  now = 9500;
  t.mock.timers.tick(1800);
  assert.equal(calls, 1);
  assert.equal(window.getSnapshot(), 0);
  now = 10_100;
  assert.equal(window.getSnapshot(), 0, "expiry cannot be reversed by a clock correction");
  stop();
});

test("cleanup cancels pending work and disabled or expired readers never subscribe a timer", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let calls = 0;
  const window = createStepSweepWindow(10_000, true);
  const cleanup = window.subscribe(() => calls++);
  cleanup();
  const unsubscribe = window.subscribe(() => calls++);
  unsubscribe();
  for (const candidate of [createStepSweepWindow(10_000, false), createStepSweepWindow(7000, true), createStepSweepWindow(undefined, true)]) {
    assert.equal(candidate.getSnapshot(), 0);
    candidate.subscribe(() => calls++)();
  }
  t.mock.timers.tick(5000);
  assert.equal(calls, 0);
});
