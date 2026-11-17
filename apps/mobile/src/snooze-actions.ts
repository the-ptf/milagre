import {
  isSnoozed,
  snoozeChoices,
  snoozeDurationLabel,
  snoozeTimeLabel,
  snoozeUntilForId,
  SNOOZE_PRESET_DEFAULTS,
  type SnoozePreset,
} from "@milagre/shared/snooze";
import type { MenuSection } from "./primitives/menu";

// A Chat row's Snooze and Wake, as menu choices and the patches they send (snooze.mjs). Kept free of React Native so

type SnoozeChat = { snoozed_until?: number; done_at?: number; archived?: boolean };

const MINUTE = 60 * 1000;
const SNOOZE_FOR = "snooze-for";
const SNOOZE_CHOICE = "snooze:";
const SNOOZE_AT = "snooze-at:";
export const WAKE = "wake";

export function snoozeMenuSection(
  chat: SnoozeChat,
  minutes: number,
  presets: readonly SnoozePreset[] = SNOOZE_PRESET_DEFAULTS,
  now = Date.now(),
): MenuSection | null {
  if (chat.archived || chat.done_at) return null;
  if (isSnoozed(chat, now)) return { items: [{ id: WAKE, title: "Wake", systemImage: "alarm" }] };
  const choices = snoozeChoices(now, presets);
  return {
    items: [
      { id: SNOOZE_FOR, title: `Snooze for ${snoozeDurationLabel(minutes)}`, systemImage: "moon.zzz" },
      ...(choices.length
        ? [
            {
              id: "snooze-until",
              title: "Snooze until",
              systemImage: "clock",
              submenu: choices.map((choice) => ({
                id: `${SNOOZE_CHOICE}${choice.id}`,
                title: choice.label,
                subtitle: snoozeTimeLabel(choice.until, now),
              })),
            },
          ]
        : []),
    ],
  };
}

export function settleSnooze(action: string, minutes: number, now = Date.now()): string {
  if (action === SNOOZE_FOR) return snoozeAt(now + minutes * MINUTE);
  if (!action.startsWith(SNOOZE_CHOICE)) return action;
  const until = snoozeUntilForId(action.slice(SNOOZE_CHOICE.length), now);
  return until === null ? action : snoozeAt(until);
}

export const snoozeAt = (until: number) => `${SNOOZE_AT}${until}`;

export function snoozeUntilOf(action: string): number | undefined {
  if (!action.startsWith(SNOOZE_AT)) return undefined;
  const until = Number(action.slice(SNOOZE_AT.length));
  return Number.isFinite(until) && until > 0 ? until : undefined;
}

export function snoozePatch(action: string): { snoozed_until: number | false } | undefined {
  if (action === WAKE) return { snoozed_until: false };
  const until = snoozeUntilOf(action);
  return until === undefined ? undefined : { snoozed_until: until };
}

export type SnoozeMark = { until: number | null };

export function snoozeMarkFor(action: string): SnoozeMark | undefined {
  if (action === WAKE) return { until: null };
  const until = snoozeUntilOf(action);
  return until === undefined ? undefined : { until };
}

export function withSnoozeMark<T extends SnoozeChat>(chat: T, mark: SnoozeMark | undefined): T {
  if (!mark) return chat;
  if (mark.until === null) return chat.snoozed_until ? { ...chat, snoozed_until: undefined } : chat;
  return chat.snoozed_until === mark.until ? chat : { ...chat, snoozed_until: mark.until };
}
