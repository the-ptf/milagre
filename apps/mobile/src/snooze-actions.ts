import { isSnoozed, snoozeChoices, snoozeDurationLabel, snoozeTimeLabel } from "@milagre/shared/snooze";
import type { MenuSection } from "./primitives/menu";

// A Chat row's Snooze and Wake, as menu choices and the patches they send (snooze.mjs). Kept free of React Native so
// the list's logic is tested in Node.

type SnoozeChat = { snoozed_until?: number; done_at?: number; archived?: boolean };

const MINUTE = 60 * 1000;
/** Snooze for the phone's default duration (snooze-setting.ts). */
const SNOOZE_FOR = "snooze-for";
/** One of the Snooze until choices, by its id: "snooze:tomorrow". */
const SNOOZE_CHOICE = "snooze:";
/** A snooze with its wake time settled: what the list and runChatAction act on, and what Redo repeats. */
const SNOOZE_AT = "snooze-at:";
export const WAKE = "wake";

/**
 * The row menu's Snooze section: Snooze for the default and a Snooze until submenu, or Wake for a snoozed Chat. None for
 * a Done or archived Chat, which Snooze doesn't apply to.
 */
export function snoozeMenuSection(chat: SnoozeChat, minutes: number, now = Date.now()): MenuSection | null {
  if (chat.archived || chat.done_at) return null;
  if (isSnoozed(chat, now)) return { items: [{ id: WAKE, title: "Wake", systemImage: "alarm" }] };
  return {
    items: [
      { id: SNOOZE_FOR, title: `Snooze for ${snoozeDurationLabel(minutes)}`, systemImage: "moon.zzz" },
      {
        id: "snooze-until",
        title: "Snooze until",
        systemImage: "clock",
        submenu: snoozeChoices(now).map((choice) => ({
          id: `${SNOOZE_CHOICE}${choice.id}`,
          title: choice.label,
          subtitle: snoozeTimeLabel(choice.until, now),
        })),
      },
    ],
  };
}

/**
 * A menu choice with its wake time read now, when it is chosen rather than when the menu was drawn: "snooze-at:<ms>".
 * Anything that isn't a Snooze choice comes back as it was.
 */
export function settleSnooze(action: string, minutes: number, now = Date.now()): string {
  if (action === SNOOZE_FOR) return snoozeAt(now + minutes * MINUTE);
  if (!action.startsWith(SNOOZE_CHOICE)) return action;
  const choice = snoozeChoices(now).find((option) => `${SNOOZE_CHOICE}${option.id}` === action);
  // "This evening" is offered until 17:00; a menu drawn before then and picked after snoozes to tomorrow morning instead.
  return snoozeAt(choice?.until ?? snoozeChoices(now).find((option) => option.id === "tomorrow")!.until);
}

export const snoozeAt = (until: number) => `${SNOOZE_AT}${until}`;

/** The wake time of a settled snooze, or undefined when the action is something else. */
export function snoozeUntilOf(action: string): number | undefined {
  if (!action.startsWith(SNOOZE_AT)) return undefined;
  const until = Number(action.slice(SNOOZE_AT.length));
  return Number.isFinite(until) && until > 0 ? until : undefined;
}

/** The session patch a settled snooze or a Wake sends, or undefined for any other action. */
export function snoozePatch(action: string): { snoozed_until: number | false } | undefined {
  if (action === WAKE) return { snoozed_until: false };
  const until = snoozeUntilOf(action);
  return until === undefined ? undefined : { snoozed_until: until };
}

/** A Snooze or Wake asked from the list, shown until its computer answers (`until` null: woken). */
export type SnoozeMark = { until: number | null };

export function snoozeMarkFor(action: string): SnoozeMark | undefined {
  if (action === WAKE) return { until: null };
  const until = snoozeUntilOf(action);
  return until === undefined ? undefined : { until };
}

/** A Chat as a pending Snooze or Wake shows it. */
export function withSnoozeMark<T extends SnoozeChat>(chat: T, mark: SnoozeMark | undefined): T {
  if (!mark) return chat;
  if (mark.until === null) return chat.snoozed_until ? { ...chat, snoozed_until: undefined } : chat;
  return chat.snoozed_until === mark.until ? chat : { ...chat, snoozed_until: mark.until };
}
