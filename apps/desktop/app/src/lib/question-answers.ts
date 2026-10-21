import type { AgentQuestion, QuestionAnswers } from "../model";

/** What the user has picked and typed for one question on a question card. */
export interface QuestionDraft {
  picked: string[];
  typed: string;
}

/** Drafts by question id. */
export type QuestionDrafts = Record<string, QuestionDraft>;

export function draftOf(drafts: QuestionDrafts, questionId: string): QuestionDraft {
  return drafts[questionId] ?? { picked: [], typed: "" };
}

/** Picks an option. A single-choice question keeps only that option and drops a typed answer; a multi-select one toggles it. */
export function pickOption(drafts: QuestionDrafts, question: AgentQuestion, label: string): QuestionDrafts {
  const draft = draftOf(drafts, question.id);
  if (!question.multiSelect) return { ...drafts, [question.id]: { picked: [label], typed: "" } };
  const picked = draft.picked.includes(label) ? draft.picked.filter((item) => item !== label) : [...draft.picked, label];
  return { ...drafts, [question.id]: { ...draft, picked } };
}

/** Types an answer of the user's own. On a single-choice question it replaces the picked option. */
export function typeAnswer(drafts: QuestionDrafts, question: AgentQuestion, typed: string): QuestionDrafts {
  const draft = draftOf(drafts, question.id);
  const picked = !question.multiSelect && typed.trim() ? [] : draft.picked;
  return { ...drafts, [question.id]: { picked, typed } };
}

/** The answers to send: picks in the agent's option order, then the typed answer. Null while a question has none. */
export function draftAnswers(questions: AgentQuestion[], drafts: QuestionDrafts): QuestionAnswers | null {
  const answers: QuestionAnswers = {};
  for (const question of questions) {
    const draft = draftOf(drafts, question.id);
    const picked = question.options.map((option) => option.label).filter((label) => draft.picked.includes(label));
    const typed = question.allowOther ? draft.typed.trim() : "";
    const values = typed ? [...picked, typed] : picked;
    if (!values.length) return null;
    answers[question.id] = values;
  }
  return answers;
}

/**
 * The answers as the chat shows them, in the user's message: one question's answers alone, several
 * one per line under their tab labels. A typed answer to a secret question is masked.
 */
export function answerSummary(questions: AgentQuestion[], answers: QuestionAnswers): string {
  const shown = (question: AgentQuestion) =>
    (answers[question.id] ?? []).map((value) => (question.secret && !question.options.some((option) => option.label === value) ? "••••••" : value)).join(", ");
  if (questions.length === 1 && questions[0]) return shown(questions[0]);
  return questions.map((question, index) => `${tabLabel(question, index)}: ${shown(question)}`).join("\n");
}

/** A card with one single-choice question sends as soon as an option is picked. */
export function sendsOnPick(questions: AgentQuestion[]): boolean {
  return questions.length === 1 && !!questions[0] && !questions[0].multiSelect;
}

/** On a card with several questions, a pick on a single-choice question moves on to the next one. The last question waits for Send, so the answers get a final look. */
export function advancesOnPick(questions: AgentQuestion[], active: number): boolean {
  return questions.length > 1 && !questions[active]?.multiSelect && primaryAction(questions, active) === "next";
}

/** Whether one question has an answer: a pick, or a typed answer where the agent allows one. */
export function questionAnswered(question: AgentQuestion, drafts: QuestionDrafts): boolean {
  return draftAnswers([question], drafts) !== null;
}

/** A tab's label: the question's header, or its position when it has none. */
export function tabLabel(question: AgentQuestion, index: number): string {
  return question.header.trim() || `Question ${index + 1}`;
}

/** The card's primary button: Next on every question but the last, which sends the answers. */
export function primaryAction(questions: AgentQuestion[], active: number): "next" | "send" {
  return active < questions.length - 1 ? "next" : "send";
}

/** Next needs the active question answered; Send needs every question answered. */
export function primaryEnabled(questions: AgentQuestion[], drafts: QuestionDrafts, active: number): boolean {
  const question = questions[active];
  if (!question) return false;
  return primaryAction(questions, active) === "next" ? questionAnswered(question, drafts) : draftAnswers(questions, drafts) !== null;
}

/** Where Next goes: one question on, staying on the last. */
export function nextTab(count: number, active: number): number {
  return Math.min(active + 1, count - 1);
}

/** Where a key moves between tabs (arrows wrap, Home and End jump), or null for any other key. */
export function arrowTab(count: number, active: number, key: string): number | null {
  if (key === "ArrowRight") return (active + 1) % count;
  if (key === "ArrowLeft") return (active - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
