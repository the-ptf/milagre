import assert from "node:assert/strict";
import test from "node:test";
import { byDoneAt, doneCountdown, doneDue, isDone, normalizeDoneSettings, retentionLabel, DONE_RETENTION_OPTIONS } from "./done.mjs";

const HOUR = 60 * 60 * 1000;

test("Done settings keep a listed retention and fall back to 24 hours", () => {
  assert.deepEqual(normalizeDoneSettings(null), { retentionHours: 24 });
  assert.deepEqual(normalizeDoneSettings({ retentionHours: 72 }), { retentionHours: 72 });
  assert.deepEqual(normalizeDoneSettings({ retentionHours: 0 }), { retentionHours: 0 });
  assert.deepEqual(normalizeDoneSettings({ retentionHours: 5 }), { retentionHours: 24 });
  assert.deepEqual(normalizeDoneSettings({ retentionHours: "24" }), { retentionHours: 24 });
});

test("each retention reads as Settings lists it", () => {
  assert.deepEqual(DONE_RETENTION_OPTIONS.map(retentionLabel), ["1 hour", "8 hours", "24 hours", "3 days", "1 week", "Never"]);
});

test("a Done Chat is due once its retention has passed, never with Never or once archived", () => {
  const at = 1_000_000;
  const chat = { done_at: at };
  assert.equal(isDone(chat), true);
  assert.equal(doneDue(chat, 24, at + 24 * HOUR - 1), false);
  assert.equal(doneDue(chat, 24, at + 24 * HOUR), true);
  assert.equal(doneDue(chat, 0, at + 1000 * HOUR), false);
  assert.equal(doneDue({ ...chat, archived: true }, 1, at + 2 * HOUR), false);
  assert.equal(doneDue({}, 1, at + 2 * HOUR), false);
});

test("the countdown reads hours:minutes left, rounds up, and stops at 0:00", () => {
  const at = 1_000;
  assert.equal(doneCountdown({ done_at: at }, 24, at + 2 * HOUR + 46 * 60_000 - 30_000), "21:15");
  assert.equal(doneCountdown({ done_at: at }, 1, at + 18 * 60_000), "0:42");
  assert.equal(doneCountdown({ done_at: at }, 1, at + 5 * HOUR), "0:00");
  assert.equal(doneCountdown({ done_at: at }, 0, at), null);
  assert.equal(doneCountdown({ done_at: at }, 24, at - 90_000), "24:00", "a clock behind the Mac's never shows more than the retention");
});

test("the Done list shows the most recently marked first", () => {
  assert.deepEqual([{ done_at: 1 }, { done_at: 3 }, { done_at: 2 }].sort(byDoneAt), [{ done_at: 3 }, { done_at: 2 }, { done_at: 1 }]);
});
