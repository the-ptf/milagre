import assert from "node:assert/strict";
import test from "node:test";
import { createDisplayClock } from "./display-clock.ts";

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
