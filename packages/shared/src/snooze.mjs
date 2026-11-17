const MINUTE = 60 * 1000;

/** Every duration Settings offers, in minutes: for the hover button and for an "In" Snooze option. */
export const SNOOZE_DURATION_OPTIONS = Object.freeze([15, 30, 60, 120, 180, 240, 480, 1440, 2880, 10080]);

export const SNOOZE_DEFAULTS = Object.freeze({ minutes: 60 });

export function normalizeSnoozeMinutes(value) {
  return SNOOZE_DURATION_OPTIONS.includes(value) ? value : SNOOZE_DEFAULTS.minutes;
}

export function snoozeDurationLabel(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 10080) return "1 week";
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

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** What an "at" Snooze option's When can be. A weekday means the next one after today. */
export const SNOOZE_PRESET_DAYS = Object.freeze(["today", "tomorrow", ...WEEKDAYS.slice(1), WEEKDAYS[0]]);

/** Every half hour, as Settings offers an "at" Snooze option's time. */
export const SNOOZE_TIMES = Object.freeze(
  Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`),
);

export const SNOOZE_PRESETS_MAX = 8;

export const SNOOZE_PRESET_DEFAULTS = Object.freeze([
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
]);

const ADD_ORDER = [...SNOOZE_PRESET_DEFAULTS, { kind: "after", minutes: 30 }, { kind: "at", day: "saturday", time: "09:00" }, { kind: "after", minutes: 1440 }];

export const snoozePresetId = (preset) => (preset.kind === "after" ? `after:${preset.minutes}` : `at:${preset.day}:${preset.time}`);

function normalizePreset(value) {
  if (value?.kind === "after" && SNOOZE_DURATION_OPTIONS.includes(value.minutes)) return { kind: "after", minutes: value.minutes };
  if (value?.kind === "at" && SNOOZE_PRESET_DAYS.includes(value.day) && SNOOZE_TIMES.includes(value.time))
    return { kind: "at", day: value.day, time: value.time };
  return null;
}

export function normalizeSnoozePresets(value) {
  if (!Array.isArray(value)) return SNOOZE_PRESET_DEFAULTS.map((preset) => ({ ...preset }));
  return value.flatMap((preset) => normalizePreset(preset) ?? []).slice(0, SNOOZE_PRESETS_MAX);
}

export const sameSnoozePresets = (a, b) => a.length === b.length && a.every((preset, index) => snoozePresetId(preset) === snoozePresetId(b[index]));

/** The option Add puts in: the first of a fixed list not already there. */
export function nextSnoozePreset(presets) {
  const taken = new Set(presets.map(snoozePresetId));
  return { ...(ADD_ORDER.find((preset) => !taken.has(snoozePresetId(preset))) ?? { kind: "after", minutes: 60 }) };
}

/** Switching an option's When keeps its time, or its duration, when the new kind has one. */
export function withSnoozePresetDay(preset, day) {
  if (day === "after") return preset.kind === "after" ? preset : { kind: "after", minutes: 60 };
  return { kind: "at", day, time: preset.kind === "at" ? preset.time : "09:00" };
}

const daysUntil = (day, now) => (day === "today" ? 0 : day === "tomorrow" ? 1 : (WEEKDAYS.indexOf(day) - new Date(now).getDay() + 7) % 7 || 7);

function presetLabel(preset, days) {
  if (preset.kind === "after") return `In ${snoozeDurationLabel(preset.minutes)}`;
  if (days === 0) {
    const hour = Number(preset.time.slice(0, 2));
    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  }
  if (days === 1) return "Tomorrow";
  if (preset.day === "monday") return "Next week";
  const name = preset.day[0].toUpperCase() + preset.day.slice(1);
  return days === 7 ? `Next ${name}` : name;
}

/** The menu choice an option makes now, or null once a time today has passed. */
export function snoozePresetChoice(preset, now = Date.now()) {
  if (preset.kind === "after") return { id: snoozePresetId(preset), label: presetLabel(preset, 0), until: now + preset.minutes * MINUTE };
  const days = daysUntil(preset.day, now);
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(Number(preset.time.slice(0, 2)), Number(preset.time.slice(3)), 0, 0);
  if (date.getTime() <= now) return null;
  return { id: snoozePresetId(preset), label: presetLabel(preset, days), until: date.getTime() };
}

/** The Snooze menu: each option's choice, soonest first, without passed times or two at the same minute. */
export function snoozeChoices(now = Date.now(), presets = SNOOZE_PRESET_DEFAULTS) {
  const minutes = new Set();
  return presets
    .flatMap((preset) => snoozePresetChoice(preset, now) ?? [])
    .sort((a, b) => a.until - b.until)
    .filter((choice) => {
      const minute = Math.floor(choice.until / MINUTE);
      if (minutes.has(minute)) return false;
      minutes.add(minute);
      return true;
    });
}

const DAY_LABELS = { after: "In", today: "Today", tomorrow: "Tomorrow" };
const dayLabel = (day) => DAY_LABELS[day] ?? day[0].toUpperCase() + day.slice(1);
const timeLabel = (time) => `${Number(time.slice(0, 2))}:${time.slice(3)}`;

/** What Settings needs to edit Snooze options: each dropdown's choices, and what each option puts in the menu now. */
export function snoozePresetEditor(presets, now = Date.now()) {
  const minutes = new Set();
  return {
    days: ["after", ...SNOOZE_PRESET_DAYS].map((value) => ({ value, label: dayLabel(value) })),
    durations: SNOOZE_DURATION_OPTIONS.map((value) => ({ value: String(value), label: snoozeDurationLabel(value) })),
    times: SNOOZE_TIMES.map((value) => ({ value, label: timeLabel(value) })),
    rows: presets.map((preset) => {
      const choice = snoozePresetChoice(preset, now);
      if (!choice) return { note: "Passed for today" };
      const minute = Math.floor(choice.until / MINUTE);
      if (minutes.has(minute)) return { note: "Same time as an option above" };
      minutes.add(minute);
      return { label: choice.label, when: snoozeTimeLabel(choice.until, now) };
    }),
  };
}

/** A choice picked from a menu drawn earlier: an "at" time that passed meanwhile moves to the same time tomorrow. */
export function snoozeUntilForId(id, now = Date.now()) {
  const [kind, first, ...rest] = String(id).split(":");
  const preset = normalizePreset(kind === "after" ? { kind, minutes: Number(first) } : { kind, day: first, time: rest.join(":") });
  if (!preset) return null;
  return snoozePresetChoice(preset, now)?.until ?? snoozePresetChoice({ ...preset, day: "tomorrow" }, now).until;
}

export function snoozeTimeLabel(until, now = Date.now()) {
  const date = new Date(until);
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** Snoozed Chats, the one waking soonest first: the order the Snoozed list shows them in. */
export const bySnoozedUntil = (a, b) => (a.snoozed_until ?? 0) - (b.snoozed_until ?? 0);
