import { useSyncExternalStore } from "react";

// How far the Subchat bookmark (components/agents/SubchatBookmark) reaches from <main>'s left edge, its gap included. The
// Routine chip's strip shares that row of the window, so it keeps clear of it (chipStripInsets); 0 while no bookmark shows.
let reserve = 0;
const listeners = new Set<() => void>();

export function setBookmarkReserve(width: number) {
  const next = Math.max(0, Math.round(width));
  if (next === reserve) return;
  reserve = next;
  for (const notify of listeners) notify();
}

export function useBookmarkReserve(): number {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => reserve,
  );
}
