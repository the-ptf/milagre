import test from "node:test";
import assert from "node:assert/strict";
import { notificationAllowed, parseNotificationSchedule } from "./notification-schedule.mjs";

const work = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timeZone: "America/Toronto" };
test("old preferences allow notifications at any time", () => {
  assert.equal(parseNotificationSchedule(undefined), null);
  assert.equal(notificationAllowed(null, Date.parse("2026-10-25T23:00:00Z")), true);
});
test("work hours include opening, exclude closing and weekends in the chosen timezone", () => {
  for (const [date, allowed] of [
    ["2026-10-21T12:59Z", false],
    ["2026-10-21T13:00Z", true],
    ["2026-10-21T20:59Z", true],
    ["2026-10-21T21:00Z", false],
    ["2026-10-24T15:00Z", false],
  ])
    assert.equal(notificationAllowed(work, Date.parse(date)), allowed, date);
});
test("overnight windows belong to their starting day across the week boundary", () => {
  const night = { ...work, days: [6], start: "22:00", end: "06:00" };
  assert.equal(notificationAllowed(night, Date.parse("2026-10-25T03:00Z")), true);
  assert.equal(notificationAllowed(night, Date.parse("2026-10-25T09:59Z")), true);
  assert.equal(notificationAllowed(night, Date.parse("2026-10-25T10:00Z")), false);
  assert.equal(notificationAllowed(night, Date.parse("2026-10-24T05:00Z")), false);
});
test("daylight saving follows wall time, including the repeated hour", () => {
  assert.equal(notificationAllowed(work, Date.parse("2026-11-02T13:59Z")), false);
  assert.equal(notificationAllowed(work, Date.parse("2026-11-02T14:00Z")), true);
  const repeated = { ...work, days: [0], start: "01:00", end: "02:00" };
  assert.equal(notificationAllowed(repeated, Date.parse("2026-11-01T05:30Z")), true);
  assert.equal(notificationAllowed(repeated, Date.parse("2026-11-01T06:30Z")), true);
});
test("invalid schedules are rejected instead of silently enabling alerts", () => {
  for (const value of [
    {},
    { ...work, days: [] },
    { ...work, days: [7] },
    { ...work, start: "24:00" },
    { ...work, start: work.end },
    { ...work, timeZone: "Invalid/Zone" },
  ])
    assert.throws(() => parseNotificationSchedule(value), /Invalid notification schedule/);
});

test("phones without supportedValuesOf still offer the full timezone catalog", async () => {
  const original = Intl.supportedValuesOf;
  try {
    Intl.supportedValuesOf = undefined;
    const { notificationTimeZones } = await import("./notification-schedule.mjs");
    const zones = notificationTimeZones();
    assert.ok(zones.length > 400);
    assert.ok(zones.includes("UTC"));
    assert.ok(zones.includes("Pacific/Auckland"));
    assert.ok(zones.includes("Africa/Johannesburg"));
  } finally {
    Intl.supportedValuesOf = original;
  }
});
