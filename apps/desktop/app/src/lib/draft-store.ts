import { useSyncExternalStore } from "react";

/** The key a Chat's draft is kept under; the new-chat screen of each scope has its own. */
export function draftKey(owner: string, sessionId: number | null | undefined): string {
  return `${owner}#${sessionId ?? "new"}`;
}

/**
 * Every Chat's composer text, held outside React state so typing re-renders only the components that read it.
 * `get` and `set` act on the selected Chat's draft; `select` switches Chats and leaves the others untouched.
 */
export function createDraftStore(initialKey = "") {
  const values = new Map<string, string>();
  let key = initialKey;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const get = () => values.get(key) ?? "";
  return {
    get,
    set: (next: string) => {
      if (next === get()) return;
      if (next) values.set(key, next);
      else values.delete(key);
      notify();
    },
    /** Hands over the draft kept under `other` and clears it there: text typed in a screen that is being left. */
    take: (other: string) => {
      const value = values.get(other) ?? "";
      if (!value) return "";
      values.delete(other);
      if (other === key) notify();
      return value;
    },
    select: (next: string) => {
      if (next === key) return;
      key = next;
      notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

export function useDraft(store: DraftStore): string {
  return useSyncExternalStore(store.subscribe, store.get);
}
