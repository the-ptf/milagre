import type { AgentQuestion, QuestionRequest } from "./model.ts";

export const QUESTION_COMPOSER_COPY = {
  skip: "Skip",
  skipLabel: "Skip the question",
  pickAny: "Pick any that apply.",
  previous: "Previous question",
  next: "Next question",
} as const;

/**
 * Whether a question is answered in the composer: its options sit above the prompt and the prompt is the typed
 * answer. A Milagre secret, a bug report and a masked question keep their own card, since the prompt can't hide text.
 */
export function asksInComposer(request: QuestionRequest): boolean {
  return !request.secretRequest && !request.bugReport && !request.questions.some((question) => question.secret);
}

export function answerPlaceholder(question: Pick<AgentQuestion, "options" | "allowOther">): string {
  if (!question.allowOther) return "Choose an option above";
  return question.options.length ? "Or type your own answer…" : "Type your answer…";
}

export function questionPosition(active: number, count: number): string {
  return `${active + 1} of ${count}`;
}
