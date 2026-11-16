// DOM intact so coming back to one skips parsing and laying its messages out again (what MonoCode's TranscriptPool

const TRANSCRIPT_SLOT_LIMIT = 4;

export type TranscriptSlot<T> = { id: number; key: string; element: T; shownAt: number };

export function showSlot<T>(slots: TranscriptSlot<T>[], key: string, element: T, alias?: string): TranscriptSlot<T>[] {
  let at = slots.findIndex((slot) => slot.key === key);
  if (at < 0 && alias !== undefined) at = slots.findIndex((slot) => slot.key === alias);
  const shownAt = slots.reduce((latest, slot) => Math.max(latest, slot.shownAt), 0) + 1;
  if (at < 0) return [...slots, { id: slots.reduce((latest, slot) => Math.max(latest, slot.id), 0) + 1, key, element, shownAt }];
  const current = slots[at]!;
  if (current.key === key && current.element === element && current.shownAt === shownAt - 1) return slots;
  return slots.map((slot, index) => (index === at ? { ...slot, key, element, shownAt } : slot));
}

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

export function dropSlot<T>(slots: TranscriptSlot<T>[], key: string): TranscriptSlot<T>[] {
  return slots.some((slot) => slot.key === key) ? slots.filter((slot) => slot.key !== key) : slots;
}
