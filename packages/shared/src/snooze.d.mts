type SnoozeSession = { snoozed_until?: number; done_at?: number; archived?: boolean };

export type SnoozePresetDay = "today" | "tomorrow" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

/** A Snooze menu option: a duration from now, or a time on a day. */
export type SnoozePreset = { kind: "after"; minutes: number } | { kind: "at"; day: SnoozePresetDay; time: string };

export interface SnoozeChoice {
  /** snoozePresetId of the option it came from. */
  id: string;
  label: string;
  /** When the Chat wakes, in ms. */
  until: number;
}

export const SNOOZE_DURATION_OPTIONS: readonly number[];
export const SNOOZE_DEFAULTS: Readonly<{ minutes: number }>;
export function normalizeSnoozeMinutes(value: unknown): number;
export function snoozeDurationLabel(minutes: number): string;
export function isSnoozed(session: SnoozeSession | undefined | null, now?: number): boolean;
export function snoozeDue(session: SnoozeSession | undefined | null, now?: number): boolean;
export function wakesSnoozed(event: { type?: string } | undefined | null): boolean;
export function snoozeWakeLabel(until: number, now?: number): string;
export const SNOOZE_PRESET_DAYS: readonly SnoozePresetDay[];
export const SNOOZE_TIMES: readonly string[];
export const SNOOZE_PRESETS_MAX: number;
export const SNOOZE_PRESET_DEFAULTS: readonly SnoozePreset[];
export function snoozePresetId(preset: SnoozePreset): string;
export function normalizeSnoozePresets(value: unknown): SnoozePreset[];
export function sameSnoozePresets(a: readonly SnoozePreset[], b: readonly SnoozePreset[]): boolean;
export function nextSnoozePreset(presets: readonly SnoozePreset[]): SnoozePreset;
export function withSnoozePresetDay(preset: SnoozePreset, day: SnoozePresetDay | "after"): SnoozePreset;
export function snoozePresetChoice(preset: SnoozePreset, now?: number): SnoozeChoice | null;
export function snoozeChoices(now?: number, presets?: readonly SnoozePreset[]): SnoozeChoice[];
export interface SnoozePresetEditor {
  days: { value: SnoozePresetDay | "after"; label: string }[];
  durations: { value: string; label: string }[];
  times: { value: string; label: string }[];
  /** Per option: its menu label and wake time, or why the menu leaves it out. */
  rows: ({ label: string; when: string; note?: undefined } | { note: string; label?: undefined; when?: undefined })[];
}
export function snoozePresetEditor(presets: readonly SnoozePreset[], now?: number): SnoozePresetEditor;
export function snoozeUntilForId(id: string, now?: number): number | null;
export function snoozeTimeLabel(until: number, now?: number): string;
export function bySnoozedUntil(a: { snoozed_until?: number }, b: { snoozed_until?: number }): number;
