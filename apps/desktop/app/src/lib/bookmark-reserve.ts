import { useSyncExternalStore } from "react";

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
