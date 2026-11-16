import { createContext, useContext, useEffect, useReducer } from "react";
import type { AgentRuns, QueuedRunEvent } from "./agent-runs";

export interface RunTextStore {
  read(chatKey: string): string | undefined;
  subscribe(chatKey: string, listener: () => void): () => void;
  notify(chatKeys: Iterable<string>): void;
}

export function createRunTextStore(read: (chatKey: string) => string | undefined): RunTextStore {
  const listeners = new Map<string, Set<() => void>>();
  return {
    read,
    subscribe(chatKey, listener) {
      let set = listeners.get(chatKey);
      if (!set) listeners.set(chatKey, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size && listeners.get(chatKey) === set) listeners.delete(chatKey);
      };
    },
    notify(chatKeys) {
      for (const chatKey of new Set(chatKeys)) for (const listener of Array.from(listeners.get(chatKey) ?? [])) listener();
    },
  };
}

export function onlyTextChanged(previous: AgentRuns, batch: readonly QueuedRunEvent[]): boolean {
  return batch.every(({ chatId, event }) => event.type === "text-delta" && Boolean(previous[chatId]) && !previous[chatId]?.waitingForSubagents);
}

export const RunTextContext = createContext<RunTextStore | null>(null);

export function useRunText(chatKey: string | undefined): string | undefined {
  const store = useContext(RunTextContext);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const text = store && chatKey ? store.read(chatKey) : undefined;
  useEffect(() => {
    if (!store || !chatKey) return;
    const unsubscribe = store.subscribe(chatKey, rerender);
    if (store.read(chatKey) !== text) rerender();
    return unsubscribe;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `text` is only compared once, right after subscribing
  }, [store, chatKey]);
  return text;
}
