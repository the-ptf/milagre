import type { ComponentProps } from "react";
import { useDraftQuotes, useDraftText, type DraftStore } from "../lib/draft-store";
import { ChatComposer } from "./ChatComposer";

/** ChatComposer with its draft read from a store, so a keystroke re-renders this and not the App that owns the store. */
export function DraftChatComposer({
  store,
  ...props
}: Omit<ComponentProps<typeof ChatComposer>, "draft" | "onDraftChange" | "quotes" | "onQuotesChange"> & { store: DraftStore }) {
  const draft = useDraftText(store);
  const quotes = useDraftQuotes(store);
  return <ChatComposer {...props} draft={draft} onDraftChange={store.setText} quotes={quotes} onQuotesChange={store.setQuotes} />;
}
