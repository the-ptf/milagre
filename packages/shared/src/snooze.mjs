const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The default-duration choices Settings lists, in minutes. The hover button snoozes for the one picked. */
export const SNOOZE_DURATION_OPTIONS = Object.freeze([30, 60, 180, 480, 1440]);

export const SNOOZE_DEFAULTS = Object.freeze({ minutes: 60 });

export function normalizeSnoozeMinutes(value) {
  return SNOOZE_DURATION_OPTIONS.includes(value) ? value : SNOOZE_DEFAULTS.minutes;
}

export function snoozeDurationLabel(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day" : `${minutes / 1440} days`;
  return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
}

export function isSnoozed(session, now = Date.now()) {
  return Boolean(session?.snoozed_until) && session.snoozed_until > now && !session.done_at && !session.archived;
}

export const snoozeDue = (session, now = Date.now()) => Boolean(session?.snoozed_until) && session.snoozed_until <= now;

export const wakesSnoozed = (event) => ["permission-request", "question-request", "turn-failed"].includes(event?.type);

/** Rounded to the nearest minute: "45m", "3h", "2d". */
export function snoozeWakeLabel(until, now = Date.now()) {
  const minutes = Math.max(1, Math.round((until - now) / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function at(now, days, hour) {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

/** Soonest first, each with the time it wakes at. This evening (18:00) only before 17:00; Next week is Monday 9:00. */
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

export function snoozeTimeLabel(until, now = Date.now()) {
  const date = new Date(until);
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** Snoozed Chats, the one waking soonest first: the order the Snoozed list shows them in. */
export const bySnoozedUntil = (a, b) => (a.snoozed_until ?? 0) - (b.snoozed_until ?? 0);
