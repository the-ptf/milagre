// The transcripts a Chat window keeps mounted: the one on screen and the last few shown before it, parked with their
// DOM intact so coming back to one skips parsing and laying its messages out again (what MonoCode's TranscriptPool
// does). Slots keep their arrival order and a number of their own, so a switch never moves a mounted transcript to
// another place in the tree, and a draft's slot can become its saved Chat's without a remount.

/** How many transcripts stay mounted besides the one on screen. */
const TRANSCRIPT_SLOT_LIMIT = 4;

export type TranscriptSlot<T> = { id: number; key: string; element: T; shownAt: number };

/**
 * `slots` with Chat `key` showing `element`: its slot updated in place, else the slot named `alias` (a draft's, before
 * its Chat was saved) taken over, else a new one appended.
 */
export function showSlot<T>(slots: TranscriptSlot<T>[], key: string, element: T, alias?: string): TranscriptSlot<T>[] {
  let at = slots.findIndex((slot) => slot.key === key);
  if (at < 0 && alias !== undefined) at = slots.findIndex((slot) => slot.key === alias);
  const shownAt = slots.reduce((latest, slot) => Math.max(latest, slot.shownAt), 0) + 1;
  if (at < 0) return [...slots, { id: slots.reduce((latest, slot) => Math.max(latest, slot.id), 0) + 1, key, element, shownAt }];
  const current = slots[at]!;
  if (current.key === key && current.element === element && current.shownAt === shownAt - 1) return slots;
  return slots.map((slot, index) => (index === at ? { ...slot, key, element, shownAt } : slot));
}

/** `slots` without the ones shown longest ago past `limit` parked transcripts; the active one always stays. */
export function trimSlots<T>(slots: TranscriptSlot<T>[], active: string | null, limit = TRANSCRIPT_SLOT_LIMIT): TranscriptSlot<T>[] {
  const parked = slots.filter((slot) => slot.key !== active);
  if (parked.length <= limit) return slots;
  const dropped = new Set(
    parked
      .toSorted((a, b) => a.shownAt - b.shownAt)
      .slice(0, parked.length - limit)
      .map((slot) => slot.key),
  );
  return slots.filter((slot) => !dropped.has(slot.key));
}

/** `slots` without Chat `key` (its Chat was archived or removed). */
export function dropSlot<T>(slots: TranscriptSlot<T>[], key: string): TranscriptSlot<T>[] {
  return slots.some((slot) => slot.key === key) ? slots.filter((slot) => slot.key !== key) : slots;
}
