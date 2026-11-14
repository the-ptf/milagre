import { test } from "node:test";
import assert from "node:assert/strict";
import { settleSnooze, snoozeAt, snoozeMarkFor, snoozeMenuSection, snoozePatch, snoozeUntilOf, WAKE, withSnoozeMark } from "./snooze-actions.ts";

const MINUTE = 60 * 1000;
// A Wednesday at 10:00 local time: every Snooze until choice is on offer.
const now = new Date(2026, 10, 11, 10, 0, 0, 0).getTime();

test("an awake Chat offers Snooze for the default and a Snooze until submenu", () => {
  const section = snoozeMenuSection({}, 180, now);
  assert.deepEqual(
    section?.items.map((item) => item.id),
    ["snooze-for", "snooze-until"],
  );
  assert.equal(section?.items[0]?.title, "Snooze for 3 hours");
  assert.deepEqual(
    section?.items[1]?.submenu?.map((item) => item.title),
    ["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Next week"],
  );
  assert.equal(section?.items[1]?.submenu?.[2]?.subtitle, "18:00");
});

test("a snoozed Chat offers Wake; a Done or archived one no Snooze at all", () => {
  assert.deepEqual(
    snoozeMenuSection({ snoozed_until: now + MINUTE }, 60, now)?.items.map((item) => item.id),
    [WAKE],
  );
  assert.equal(snoozeMenuSection({ done_at: now }, 60, now), null);
  assert.equal(snoozeMenuSection({ archived: true }, 60, now), null);
  // A wake time already passed is awake again.
  assert.equal(snoozeMenuSection({ snoozed_until: now - MINUTE }, 60, now)?.items[0]?.id, "snooze-for");
});

test("a choice takes its wake time when it is picked", () => {
  assert.equal(settleSnooze("snooze-for", 30, now), snoozeAt(now + 30 * MINUTE));
  assert.equal(settleSnooze("snooze:3h", 60, now), snoozeAt(now + 180 * MINUTE));
  assert.equal(settleSnooze("snooze:tomorrow", 60, now), snoozeAt(new Date(2026, 10, 12, 9).getTime()));
  // This evening picked after 17:00 (the menu was drawn earlier) goes to tomorrow morning.
  const late = new Date(2026, 10, 11, 17, 30).getTime();
  assert.equal(settleSnooze("snooze:evening", 60, late), snoozeAt(new Date(2026, 10, 12, 9).getTime()));
  // Anything else, and a settled snooze (Redo), passes through.
  assert.equal(settleSnooze("done", 60, now), "done");
  assert.equal(settleSnooze(snoozeAt(123), 60, now), snoozeAt(123));
});

test("a settled snooze and Wake patch the Chat's wake time", () => {
  assert.deepEqual(snoozePatch(snoozeAt(now + MINUTE)), { snoozed_until: now + MINUTE });
  assert.deepEqual(snoozePatch(WAKE), { snoozed_until: false });
  assert.equal(snoozePatch("done"), undefined);
  assert.equal(snoozePatch("snooze-for"), undefined);
  assert.equal(snoozeUntilOf("snooze-at:nope"), undefined);
});

test("a pending Snooze or Wake shows on the row until its computer answers", () => {
  const until = now + MINUTE;
  const awake: { id: number; snoozed_until?: number } = { id: 1 };
  const snoozed = withSnoozeMark(awake, snoozeMarkFor(snoozeAt(until)));
  assert.equal(snoozed.snoozed_until, until);
  assert.equal(withSnoozeMark(snoozed, snoozeMarkFor(WAKE)).snoozed_until, undefined);
  // Once the computer's copy agrees, the Chat is passed through as it is.
  assert.equal(withSnoozeMark(snoozed, { until }), snoozed);
  assert.equal(withSnoozeMark(awake, { until: null }), awake);
  assert.equal(withSnoozeMark(awake, undefined), awake);
});
