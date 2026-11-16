import type { ComponentProps } from "react";
import { useDraftQuotes, useDraftText, type DraftStore } from "../lib/draft-store";
import { PromptComposer } from "./PromptComposer";

/**
 * PromptComposer with its draft read from a store: the one subscriber to the draft, so a keystroke re-renders the prompt
 * and not ChatComposer around it, nor the App that owns the store.
 */
export function DraftPromptComposer({
  store,
  ...props
}: Omit<ComponentProps<typeof PromptComposer>, "draft" | "onDraftChange" | "quotes" | "onRemoveQuote"> & { store: DraftStore }) {
  const draft = useDraftText(store);
  const quotes = useDraftQuotes(store);
  return (
    <PromptComposer
      {...props}
      draft={draft}
      onDraftChange={store.setText}
      quotes={quotes}
      onRemoveQuote={(id) => store.setQuotes(quotes.filter((quote) => quote.id !== id))}
    />
  );
}
