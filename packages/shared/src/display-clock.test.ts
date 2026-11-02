import assert from "node:assert/strict";
import test from "node:test";
import { createDisplayClock, formatElapsed, formatCountdown } from "./display-clock.ts";

test("hidden display clocks stop scheduling, catch up immediately on return and detach when unused", () => {
  let visible = true,
    now = 1000,
    ticks = 0;
  let visibility: (() => void) | undefined;
  const scheduled = new Set<() => void>();
  const clock = createDisplayClock({
    intervalMs: 100,
    now: () => now,
    isVisible: () => visible,
    onVisibility: (fn) => {
      visibility = fn;
      return () => {
        visibility = undefined;
      };
    },
    setInterval: (fn) => {
      scheduled.add(fn);
      return fn;
    },
    clearInterval: (fn) => {
      scheduled.delete(fn);
    },
  });
  const off = clock.subscribe(() => ticks++);
  const other = clock.subscribe(() => {});
  assert.equal(scheduled.size, 1, "display clocks share a timer");
  now = 1100;
  for (const fn of scheduled) fn();
  assert.equal(clock.snapshot(), 1100);
  visible = false;
  visibility!();
  assert.equal(scheduled.size, 0);
  const before = ticks;
  now = 20_000;
  assert.equal(ticks, before);
  visible = true;
  visibility!();
  assert.equal(clock.snapshot(), 20_000);
  assert.equal(ticks, before + 1);
  off();
  assert.equal(scheduled.size, 1);
  other();
  assert.equal(scheduled.size, 0);
  assert.equal(visibility, undefined);
});

test("subscribing while hidden schedules no timer; a later subscriber gets current wall time", () => {
  let now = 10;
  const clock = createDisplayClock({
    intervalMs: 100,
    now: () => now,
    isVisible: () => false,
    onVisibility: () => () => {},
    setInterval: () => {
      throw new Error("hidden timer");
    },
    clearInterval: () => {},
  });
  now = 100;
  const off = clock.subscribe(() => {});
  assert.equal(clock.snapshot(), 100);
  off();
});

test("live elapsed labels floor seconds, clamp negatives and pad smaller units", () => {
  for (const [ms, label] of [
    [-5, "0s"],
    [0, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [61_000, "1m 01s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 00m 00s"],
    [7_985_000, "2h 13m 05s"],
  ] as const)
    assert.equal(formatElapsed(ms), label, `${ms} ms`);
});

test("countdown rounds up at second boundaries and stops at zero", () => {
  assert.equal(formatCountdown(300000), "5:00");
  assert.equal(formatCountdown(299999), "5:00");
  assert.equal(formatCountdown(299000), "4:59");
  assert.equal(formatCountdown(1), "0:01");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-1000), "0:00");
});
