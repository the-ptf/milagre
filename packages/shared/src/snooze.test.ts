import assert from "node:assert/strict";
import test from "node:test";
import {
  bySnoozedUntil,
  isSnoozed,
  normalizeSnoozeMinutes,
  snoozeChoices,
  snoozeDue,
  snoozeDurationLabel,
  snoozeWakeLabel,
  wakesSnoozed,
  SNOOZE_DURATION_OPTIONS,
} from "./snooze.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("the default duration keeps a listed choice and falls back to 1 hour", () => {
  assert.equal(normalizeSnoozeMinutes(180), 180);
  assert.equal(normalizeSnoozeMinutes(7), 60);
  assert.equal(normalizeSnoozeMinutes("60"), 60);
  assert.deepEqual(SNOOZE_DURATION_OPTIONS.map(snoozeDurationLabel), ["30 minutes", "1 hour", "3 hours", "8 hours", "1 day"]);
});

test("a Chat is snoozed while its wake time is ahead, and never once Done or archived", () => {
  const now = 1_000_000;
  assert.equal(isSnoozed({ snoozed_until: now + 1 }, now), true);
  assert.equal(isSnoozed({ snoozed_until: now }, now), false);
  assert.equal(isSnoozed({ snoozed_until: now + HOUR, done_at: 1 }, now), false);
  assert.equal(isSnoozed({ snoozed_until: now + HOUR, archived: true }, now), false);
  assert.equal(isSnoozed({}, now), false);
  assert.equal(snoozeDue({ snoozed_until: now }, now), true);
  assert.equal(snoozeDue({ snoozed_until: now + 1 }, now), false);
});

test("a question, an approval or a failed turn wakes a snoozed Chat; a finished turn doesn't", () => {
  assert.equal(wakesSnoozed({ type: "question-request" }), true);
  assert.equal(wakesSnoozed({ type: "permission-request" }), true);
  assert.equal(wakesSnoozed({ type: "turn-failed" }), true);
  assert.equal(wakesSnoozed({ type: "turn-completed" }), false);
  assert.equal(wakesSnoozed(null), false);
});

test("the wake label reads minutes, hours or days left", () => {
  assert.equal(snoozeWakeLabel(45 * MINUTE, 0), "45m");
  assert.equal(snoozeWakeLabel(10_000, 0), "1m");
  assert.equal(snoozeWakeLabel(30 * MINUTE + 25_000, 0), "30m", "a row clock up to 30 s behind still reads the duration picked");
  assert.equal(snoozeWakeLabel(3 * HOUR, 0), "3h");
  assert.equal(snoozeWakeLabel(50 * HOUR, 0), "2d");
});

test("the menu offers durations, this evening before 17:00, tomorrow and next Monday, soonest first", () => {
  const morning = new Date(2026, 10, 13, 10, 0).getTime(); // a Friday
  const choices = snoozeChoices(morning);
  assert.deepEqual(
    choices.map((choice) => choice.id),
    ["1h", "3h", "evening", "tomorrow", "next-week"],
  );
  assert.equal(new Date(choices[2].until).getHours(), 18);
  assert.equal(new Date(choices[4].until).getDay(), 1);
  assert.equal(new Date(choices[4].until).getDate(), 16);
  const late = new Date(2026, 10, 13, 20, 0).getTime();
  assert.equal(
    snoozeChoices(late).some((choice) => choice.id === "evening"),
    false,
  );
  const monday = new Date(2026, 10, 16, 10, 0).getTime();
  assert.equal(new Date(snoozeChoices(monday).at(-1).until).getDate(), 23, "on a Monday, next week is the Monday after");
});

test("the Snoozed list shows the Chat waking soonest first", () => {
  assert.deepEqual([{ snoozed_until: 3 }, { snoozed_until: 1 }].sort(bySnoozedUntil), [{ snoozed_until: 1 }, { snoozed_until: 3 }]);
});
