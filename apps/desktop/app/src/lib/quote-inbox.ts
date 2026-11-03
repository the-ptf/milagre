import { useEffect } from "react";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";

// Quotes taken from an unfocused grid tile wait here, under the tile's Chat key, until that Chat's composer opens
// (the tile is focused) and takes them. App's, a Link's and a bot's composers each keep their own drafts; this reaches all.
const waiting = new Map<string, ComposerQuote[]>();
const listeners = new Set<() => void>();

export function sendQuote(chatKey: string, quote: ComposerQuote) {
  waiting.set(chatKey, [...(waiting.get(chatKey) ?? []), quote]);
  for (const listener of listeners) listener();
}

/** Hands the quotes waiting for `chatKey` to `receive`, now and whenever more arrive. */
export function useQuoteInbox(chatKey: string | null, receive: (quotes: readonly ComposerQuote[]) => void) {
  useEffect(() => {
    if (!chatKey) return;
    const take = () => {
      const quotes = waiting.get(chatKey);
      if (!quotes) return;
      waiting.delete(chatKey);
      receive(quotes);
    };
    take();
    listeners.add(take);
    return () => void listeners.delete(take);
  }, [chatKey, receive]);
}
