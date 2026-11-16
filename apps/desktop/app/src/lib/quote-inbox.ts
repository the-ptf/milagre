import { useEffect } from "react";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";

const waiting = new Map<string, ComposerQuote[]>();
const listeners = new Set<() => void>();

export function sendQuote(chatKey: string, quote: ComposerQuote) {
  waiting.set(chatKey, [...(waiting.get(chatKey) ?? []), quote]);
  for (const listener of listeners) listener();
}

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
