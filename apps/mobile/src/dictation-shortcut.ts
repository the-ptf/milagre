import { useCallback } from "react";
import { useFocusEffect } from "expo-router";

type Target = { focused: () => boolean; dictating: () => boolean; available: () => boolean; toggle: () => void };
type Entry = Target & { usedAt: number };
const targets = new Set<Entry>();

/** The current native keyboard module reports presses. Route each to one active composer. */
export function toggleDictationShortcut() {
  const entries = [...targets].filter((entry) => entry.available());
  const target = entries.find((entry) => entry.focused()) ?? entries.find((entry) => entry.dictating()) ?? entries.toSorted((a, b) => b.usedAt - a.usedAt)[0];
  if (!target) return;
  target.usedAt = Date.now();
  target.toggle();
}

/** Hidden routes never receive the shortcut, and a split view still starts only one take. */
export function useDictationShortcut(target: Target) {
  useFocusEffect(
    useCallback(() => {
      const entry: Entry = { ...target, usedAt: Date.now() };
      targets.add(entry);
      return () => {
        targets.delete(entry);
      };
    }, [target]),
  );
}
