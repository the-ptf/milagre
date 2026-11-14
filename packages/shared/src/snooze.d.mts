type SnoozeSession = { snoozed_until?: number; done_at?: number; archived?: boolean };

export interface SnoozeChoice {
  id: "1h" | "3h" | "evening" | "tomorrow" | "next-week";
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
export function snoozeChoices(now?: number): SnoozeChoice[];
export function snoozeTimeLabel(until: number, now?: number): string;
export function bySnoozedUntil(a: { snoozed_until?: number }, b: { snoozed_until?: number }): number;
