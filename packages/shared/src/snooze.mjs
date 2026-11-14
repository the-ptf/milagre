// Snooze: put a Chat out of the way for a while. It keeps working, sends no completion notification, and sits in the
// Snoozed list at the bottom of the sidebar until its time comes (the host's sweep wakes it) or it needs the user: a
// question, an approval or a failed turn wakes it at once. A finished turn does not. Types: snooze.d.mts.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The default-duration choices Settings lists, in minutes. The hover button snoozes for the one picked. */
export const SNOOZE_DURATION_OPTIONS = Object.freeze([30, 60, 180, 480, 1440]);

export const SNOOZE_DEFAULTS = Object.freeze({ minutes: 60 });

/** The setting with anything unknown back at its default. */
export function normalizeSnoozeMinutes(value) {
  return SNOOZE_DURATION_OPTIONS.includes(value) ? value : SNOOZE_DEFAULTS.minutes;
}

/** "30 minutes", "1 hour", "3 hours", "1 day". */
export function snoozeDurationLabel(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day" : `${minutes / 1440} days`;
  return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
}

/** Whether a Chat is snoozed now: a wake time still ahead, not Done and not archived. */
export function isSnoozed(session, now = Date.now()) {
  return Boolean(session?.snoozed_until) && session.snoozed_until > now && !session.done_at && !session.archived;
}

/** Whether the host's sweep wakes this Chat now: its wake time has passed. */
export const snoozeDue = (session, now = Date.now()) => Boolean(session?.snoozed_until) && session.snoozed_until <= now;

/** Whether an agent event wakes a snoozed Chat: the Chat needs the user (a question, an approval) or its turn failed. */
export const wakesSnoozed = (event) => ["permission-request", "question-request", "turn-failed"].includes(event?.type);

/**
 * How long until a snoozed Chat wakes, as its row shows it: "45m", "3h", "2d". To the nearest minute: the rows' clocks
 * tick every 30 seconds, and rounding up made a Chat just snoozed for 30 minutes read "31m".
 */
export function snoozeWakeLabel(until, now = Date.now()) {
  const minutes = Math.max(1, Math.round((until - now) / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The time a preset wakes at, in local time. */
function at(now, days, hour) {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

/**
 * The choices a row's Snooze menu offers, soonest first: the two durations, This evening (18:00, only before 17:00),
 * Tomorrow (9:00) and Next week (Monday 9:00). Each has the time it wakes at.
 */
export function snoozeChoices(now = Date.now()) {
  const choices = [
    { id: "1h", label: "In 1 hour", until: now + HOUR },
    { id: "3h", label: "In 3 hours", until: now + 3 * HOUR },
  ];
  if (new Date(now).getHours() < 17) choices.push({ id: "evening", label: "This evening", until: at(now, 0, 18) });
  choices.push({ id: "tomorrow", label: "Tomorrow", until: at(now, 1, 9) });
  const day = new Date(now).getDay();
  choices.push({ id: "next-week", label: "Next week", until: at(now, (8 - day) % 7 || 7, 9) });
  return choices.sort((a, b) => a.until - b.until);
}

/** A wake time as a menu shows it beside its choice: "18:00", "Tue 9:00". */
export function snoozeTimeLabel(until, now = Date.now()) {
  const date = new Date(until);
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** Snoozed Chats, the one waking soonest first: the order the Snoozed list shows them in. */
export const bySnoozedUntil = (a, b) => (a.snoozed_until ?? 0) - (b.snoozed_until ?? 0);
