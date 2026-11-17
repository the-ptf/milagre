import assert from "node:assert/strict";
import test from "node:test";
import {
  bySnoozedUntil,
  nextSnoozePreset,
  normalizeSnoozePresets,
  sameSnoozePresets,
  snoozeUntilForId,
  withSnoozePresetDay,
  SNOOZE_PRESET_DEFAULTS,
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
  assert.deepEqual(SNOOZE_DURATION_OPTIONS.map(snoozeDurationLabel), [
    "15 minutes",
    "30 minutes",
    "1 hour",
    "2 hours",
    "3 hours",
    "4 hours",
    "8 hours",
    "1 day",
    "2 days",
    "1 week",
  ]);
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

test("the default menu offers durations, this evening, tomorrow and next Monday, soonest first", () => {
  const morning = new Date(2026, 10, 13, 10, 0).getTime(); // a Friday
  const choices = snoozeChoices(morning);
  assert.deepEqual(
    choices.map((choice) => choice.label),
    ["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Next week"],
  );
  assert.equal(new Date(choices[2].until).getHours(), 18);
  assert.equal(new Date(choices[4].until).getDay(), 1);
  assert.equal(new Date(choices[4].until).getDate(), 16);
  const late = new Date(2026, 10, 13, 18, 0).getTime();
  assert.equal(
    snoozeChoices(late).some((choice) => choice.label === "This evening"),
    false,
    "a time today drops out once it is reached",
  );
  const monday = new Date(2026, 10, 16, 10, 0).getTime();
  assert.equal(new Date(snoozeChoices(monday).at(-1).until).getDate(), 23, "on a Monday, next week is the Monday after");
});

test("the menu follows the options set, names days by distance and drops two at the same minute", () => {
  const friday = new Date(2026, 10, 13, 10, 0).getTime();
  const choices = snoozeChoices(friday, [
    { kind: "at", day: "friday", time: "09:00" },
    { kind: "at", day: "saturday", time: "08:00" },
    { kind: "at", day: "today", time: "11:30" },
    { kind: "after", minutes: 60 },
    { kind: "at", day: "today", time: "11:00" },
    { kind: "at", day: "tomorrow", time: "08:00" },
    { kind: "at", day: "today", time: "14:00" },
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.label),
    ["In 1 hour", "This morning", "This afternoon", "Tomorrow", "Next Friday"],
  );
});

test("Snooze options keep only valid entries, at most eight, and default when unset", () => {
  assert.deepEqual(normalizeSnoozePresets(undefined), SNOOZE_PRESET_DEFAULTS);
  assert.deepEqual(normalizeSnoozePresets([]), []);
  assert.deepEqual(
    normalizeSnoozePresets([
      { kind: "after", minutes: 7 },
      { kind: "at", day: "someday", time: "09:00" },
      { kind: "at", day: "friday", time: "09:30" },
    ]),
    [{ kind: "at", day: "friday", time: "09:30" }],
  );
  assert.equal(normalizeSnoozePresets(Array.from({ length: 12 }, () => ({ kind: "after", minutes: 60 }))).length, 8);
  assert.equal(sameSnoozePresets(normalizeSnoozePresets(undefined), SNOOZE_PRESET_DEFAULTS), true);
});

test("Add picks an option not listed yet; switching When keeps the time", () => {
  assert.deepEqual(nextSnoozePreset(SNOOZE_PRESET_DEFAULTS), { kind: "after", minutes: 30 });
  assert.deepEqual(withSnoozePresetDay({ kind: "at", day: "today", time: "18:00" }, "friday"), { kind: "at", day: "friday", time: "18:00" });
  assert.deepEqual(withSnoozePresetDay({ kind: "at", day: "today", time: "18:00" }, "after"), { kind: "after", minutes: 60 });
  assert.deepEqual(withSnoozePresetDay({ kind: "after", minutes: 30 }, "tomorrow"), { kind: "at", day: "tomorrow", time: "09:00" });
});

test("a choice picked from a menu drawn earlier wakes at its time, or the same time tomorrow once passed", () => {
  const late = new Date(2026, 10, 13, 18, 30).getTime();
  assert.equal(snoozeUntilForId("at:today:18:00", late), new Date(2026, 10, 14, 18, 0).getTime());
  assert.equal(snoozeUntilForId("after:180", late), late + 3 * HOUR);
  assert.equal(snoozeUntilForId("custom", late), null);
});

test("the Snoozed list shows the Chat waking soonest first", () => {
  assert.deepEqual([{ snoozed_until: 3 }, { snoozed_until: 1 }].sort(bySnoozedUntil), [{ snoozed_until: 1 }, { snoozed_until: 3 }]);
});
