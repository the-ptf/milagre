import { useCallback, useSyncExternalStore } from "react";
import type { DesignMode } from "@milagre/shared/design-modes";

const modes = new Map<string, DesignMode>();
const listeners = new Set<() => void>();
const keyOf = (chatId: string, id: string) => `${chatId}\n${id}`;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The color mode the canvas shows one design in; every design starts in light, and the choice lasts until the app quits. */
export function useDesignMode(chatId: string, id: string): [DesignMode, (mode: DesignMode) => void] {
  const key = keyOf(chatId, id);
  const read = (): DesignMode => modes.get(key) ?? "light";
  const mode = useSyncExternalStore(subscribe, read, read);
  const set = useCallback(
    (next: DesignMode) => {
      if (next === "light") modes.delete(key);
      else modes.set(key, next);
      for (const listener of listeners) listener();
    },
    [key],
  );
  return [mode, set];
}
