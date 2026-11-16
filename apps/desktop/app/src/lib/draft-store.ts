import { useSyncExternalStore } from "react";
import { quotedMessage, splitQuotes, type ComposerQuote } from "@milagre/shared/prompt-parts";

export function draftKey(owner: string, sessionId: number | null | undefined): string {
  return `${owner}#${sessionId ?? "new"}`;
}

type Draft = { text: string; quotes: readonly ComposerQuote[] };
const NO_QUOTES: readonly ComposerQuote[] = [];
let restoredCount = 0;

export function createDraftStore(initialKey = "") {
  const values = new Map<string, Draft>();
  const sources = new Map<string, string>();
  let key = initialKey;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const draftOf = (at: string): Draft => values.get(at) ?? { text: "", quotes: NO_QUOTES };
  const message = (draft: Draft) => quotedMessage(draft.quotes, draft.text);
  const write = (at: string, next: Draft) => {
    const current = draftOf(at);
    if (current.text === next.text && current.quotes === next.quotes) return;
    if (next.text || next.quotes.length) values.set(at, next);
    else values.delete(at);
    if (at === key) notify();
  };
  const get = () => message(draftOf(key));
  return {
    get,
    text: () => draftOf(key).text,
    quotes: () => draftOf(key).quotes,
    set: (next: string) => {
      if (next === get()) return;
      const current = draftOf(key).quotes;
      const split = splitQuotes(next);
      const quotes = split.quotes.map(
        (text, index) =>
          (current[index]?.text === text ? current[index] : undefined) ?? {
            id: `restored-${++restoredCount}`,
            text,
            ...(sources.has(text) ? { source: sources.get(text) } : {}),
          },
      );
      const same = quotes.length === current.length && quotes.every((quote, index) => quote === current[index]);
      write(key, { text: split.text, quotes: same ? current : quotes.length ? quotes : NO_QUOTES });
    },
    setText: (next: string) => write(key, { ...draftOf(key), text: next }),
    setQuotes: (next: readonly ComposerQuote[]) => {
      for (const quote of next) if (quote.source) sources.set(quote.text, quote.source);
      write(key, { ...draftOf(key), quotes: next.length ? next : NO_QUOTES });
    },
    take: (other: string) => {
      const value = message(draftOf(other));
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

export function useDraftText(store: DraftStore): string {
  return useSyncExternalStore(store.subscribe, store.text);
}

export function useDraftQuotes(store: DraftStore): readonly ComposerQuote[] {
  return useSyncExternalStore(store.subscribe, store.quotes);
}
