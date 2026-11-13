import { createContext, useContext, useEffect, useReducer } from "react";
import type { AgentRuns, QueuedRunEvent } from "./agent-runs";

/**
 * A running turn's streamed text, outside React state. Most streamed batches only grow a reply's text: rendering the
 * whole window for each one (useAgentRuns' `runs` feeds App) cost most of the renderer's work while a reply streamed.
 * Those batches only reach the components that draw the text (the transcript, a remote delegation's tail), through
 * `useRunText`; every other batch still renders the window, and the text with it in the same render.
 */
export interface RunTextStore {
  /** The latest streamed text of the chat's running turn, or undefined when it has none. */
  read(chatKey: string): string | undefined;
  subscribe(chatKey: string, listener: () => void): () => void;
  /** Tells the readers of these chats that their text may have changed. */
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

/**
 * Whether a batch changed nothing but the streamed text of runs that already existed: every event is a text delta, and
 * no run it reached was waiting on its subagents (a delta clears that, which the window shows).
 */
export function onlyTextChanged(previous: AgentRuns, batch: readonly QueuedRunEvent[]): boolean {
  return batch.every(({ chatId, event }) => event.type === "text-delta" && Boolean(previous[chatId]) && !previous[chatId]?.waitingForSubagents);
}

export const RunTextContext = createContext<RunTextStore | null>(null);

/**
 * The streamed text of `chatKey`'s running turn, kept current while it streams. Renders when the store says the text
 * changed, as a state update, so a batch that also changed the run renders this together with the window.
 */
export function useRunText(chatKey: string | undefined): string | undefined {
  const store = useContext(RunTextContext);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const text = store && chatKey ? store.read(chatKey) : undefined;
  useEffect(() => {
    if (!store || !chatKey) return;
    const unsubscribe = store.subscribe(chatKey, rerender);
    // Text that streamed between this render and the subscription.
    if (store.read(chatKey) !== text) rerender();
    return unsubscribe;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `text` is only compared once, right after subscribing
  }, [store, chatKey]);
  return text;
}
