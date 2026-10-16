import { useSyncExternalStore } from "react";
import type { ToolCallDisplay } from "@milagre/shared/chat-display";
import { readExpandReasoning, readToolCallDisplay, saveExpandReasoning, saveToolCallDisplay } from "./hosts-native";

// Settings › Chat on this phone, read once and shared by Settings and every Chat.

function phoneSetting<T>(initial: T, read: () => Promise<T>, save: (value: T) => Promise<void>) {
  let value = initial;
  let changed = false;
  const listeners = new Set<() => void>();
  void read().then((saved) => {
    if (changed) return;
    value = saved;
    listeners.forEach((listener) => listener());
  });
  return function useSetting(): [T, (next: T) => void] {
    const current = useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      () => value,
    );
    return [
      current,
      (next) => {
        changed = true;
        value = next;
        listeners.forEach((listener) => listener());
        void save(next);
      },
    ];
  };
}

/** Desktop's Tool call display: Compact folds a reply's tool calls into one row, Full detail shows each one. */
export const useToolCallDisplay = phoneSetting<ToolCallDisplay>("compact", readToolCallDisplay, saveToolCallDisplay);

/** Desktop's Always expand reasoning: thinking rows start open in the Activity sheet. */
export const useExpandReasoning = phoneSetting(false, readExpandReasoning, saveExpandReasoning);
