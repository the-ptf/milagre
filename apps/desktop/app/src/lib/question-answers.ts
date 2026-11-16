import type { AgentQuestion, ImageAttachment, QuestionAnswers, QuestionImages } from "../model";

export interface QuestionDraft {
  picked: string[];
  typed: string;
  other?: boolean;
  images?: ImageAttachment[];
}

export const MAX_ANSWER_IMAGES = 10;

export type QuestionDrafts = Record<string, QuestionDraft>;

export function draftOf(drafts: QuestionDrafts, questionId: string): QuestionDraft {
  return drafts[questionId] ?? { picked: [], typed: "" };
}

export function pickOption(drafts: QuestionDrafts, question: AgentQuestion, label: string): QuestionDrafts {
  const draft = draftOf(drafts, question.id);
  if (!question.multiSelect) return { ...drafts, [question.id]: { ...draft, picked: [label], other: false } };
  const picked = draft.picked.includes(label) ? draft.picked.filter((item) => item !== label) : [...draft.picked, label];
  return { ...drafts, [question.id]: { ...draft, picked } };
}

export function typeAnswer(drafts: QuestionDrafts, question: AgentQuestion, typed: string): QuestionDrafts {
  const draft = draftOf(drafts, question.id);
  const wrote = Boolean(typed.trim());
  const picked = !question.multiSelect && wrote ? [] : draft.picked;
  return { ...drafts, [question.id]: { ...draft, picked, typed, other: wrote || (draft.other ?? false) } };
}

export function chooseOther(drafts: QuestionDrafts, question: AgentQuestion): QuestionDrafts {
  const draft = draftOf(drafts, question.id);
  if (!question.multiSelect) return { ...drafts, [question.id]: { ...draft, picked: [], other: true } };
  return { ...drafts, [question.id]: { ...draft, other: !(draft.other ?? Boolean(draft.typed.trim())) } };
}

export function otherChosen(draft: QuestionDraft): boolean {
  return draft.other ?? Boolean(draft.typed.trim());
}

export function setAnswerImages(drafts: QuestionDrafts, question: AgentQuestion, images: ImageAttachment[]): QuestionDrafts {
  return { ...drafts, [question.id]: { ...draftOf(drafts, question.id), images } };
}

export function answerImageCount(drafts: QuestionDrafts): number {
  return Object.values(drafts).reduce((total, draft) => total + (draft.images?.length ?? 0), 0);
}

export function draftImages(questions: AgentQuestion[], drafts: QuestionDrafts): QuestionImages | undefined {
  const entries = questions.flatMap((question) => {
    const images = draftOf(drafts, question.id).images ?? [];
    return images.length ? [[question.id, images] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function withDictation(typed: string, words: string): string {
  const said = words.trim();
  if (!said) return typed;
  return typed && !/\s$/.test(typed) ? `${typed} ${said}` : `${typed}${said}`;
}

const imagesLabel = (count: number) => (count === 1 ? "1 image" : `${count} images`);

export function draftAnswers(questions: AgentQuestion[], drafts: QuestionDrafts): QuestionAnswers | null {
  const answers: QuestionAnswers = {};
  for (const question of questions) {
    const draft = draftOf(drafts, question.id);
    const picked = question.options.map((option) => option.label).filter((label) => draft.picked.includes(label));
    const typed = question.allowOther && otherChosen(draft) ? draft.typed.trim() : "";
    const values = typed ? [...picked, typed] : picked;
    if (!values.length && !draft.images?.length) return null;
    answers[question.id] = values;
  }
  return answers;
}

export function answerSummary(questions: AgentQuestion[], answers: QuestionAnswers, images?: QuestionImages): string {
  const shown = (question: AgentQuestion) =>
    [
      ...(answers[question.id] ?? []).map((value) => (question.secret && !question.options.some((option) => option.label === value) ? "••••••" : value)),
      ...(images?.[question.id]?.length ? [imagesLabel(images[question.id]!.length)] : []),
    ].join(", ");
  if (questions.length === 1 && questions[0]) return shown(questions[0]);
  return questions.map((question, index) => `${tabLabel(question, index)}: ${shown(question)}`).join("\n");
}

export function sendsOnPick(questions: AgentQuestion[]): boolean {
  return questions.length === 1 && !!questions[0] && !questions[0].multiSelect;
}

export function advancesOnPick(questions: AgentQuestion[], active: number): boolean {
  return questions.length > 1 && !questions[active]?.multiSelect && primaryAction(questions, active) === "next";
}

export function questionAnswered(question: AgentQuestion, drafts: QuestionDrafts): boolean {
  return draftAnswers([question], drafts) !== null;
}

export function tabLabel(question: AgentQuestion, index: number): string {
  return question.header.trim() || `Question ${index + 1}`;
}

export function primaryAction(questions: AgentQuestion[], active: number): "next" | "send" {
  return active < questions.length - 1 ? "next" : "send";
}

export function primaryEnabled(questions: AgentQuestion[], drafts: QuestionDrafts, active: number): boolean {
  const question = questions[active];
  if (!question) return false;
  return primaryAction(questions, active) === "next" ? questionAnswered(question, drafts) : draftAnswers(questions, drafts) !== null;
}

export function nextTab(count: number, active: number): number {
  return Math.min(active + 1, count - 1);
}

export function arrowTab(count: number, active: number, key: string): number | null {
  if (key === "ArrowRight") return (active + 1) % count;
  if (key === "ArrowLeft") return (active - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
