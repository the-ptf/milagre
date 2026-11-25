import type { ComponentProps } from "react";
import { useDraftQuotes, useDraftText, type DraftStore } from "../lib/draft-store";
import { PromptComposer } from "./PromptComposer";
import { QuestionPromptComposer, type ComposerQuestionProps } from "./agents/ComposerQuestion";

type DraftProps = Omit<ComponentProps<typeof PromptComposer>, "draft" | "onDraftChange" | "quotes" | "onRemoveQuote" | "header" | "sendReady"> & {
  store: DraftStore;
  question?: ComposerQuestionProps;
};

/**
 * PromptComposer with its draft read from a store: the one subscriber to the draft, so a keystroke re-renders the prompt
 * and not ChatComposer around it, nor the App that owns the store. While the agent waits on a question the prompt is
 * its answer instead, and the draft waits in the store until the question is answered or skipped.
 */
export function DraftPromptComposer({ store, question, ...props }: DraftProps) {
  if (question) return <QuestionPromptComposer key={question.request.requestId} question={question} {...props} />;
  return <StoredPromptComposer store={store} {...props} />;
}

function StoredPromptComposer({ store, ...props }: Omit<DraftProps, "question">) {
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
