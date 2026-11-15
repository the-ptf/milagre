import type { QuestionAnswers } from "./model.ts";

export const ESCALATION_WAIT_MS: number;
export const ESCALATION_COOLDOWN_MS: number;
export const ESCALATION_MAX_WAKES: number;
export const ESCALATION_BATCH_MS: number;
export const ESCALATION_TOOL_CALLS: number;
export const ESCALATION_TOOL_GRACE: number;

export type SubchatWaitingContext = { kind: "subchat-waiting"; ask: "question" | "approval"; parentTitle: string; waitedMs: number };

export type SubchatEscalationContext = { kind: "subchat-escalation"; from: string; fromTitle: string; requestId: string; waitedMs: number; paused?: boolean };

export type SubchatSuggestionContext = {
  kind: "subchat-suggestion";
  id: string;
  from: string;
  fromTitle: string;
  requestId: string;
  question: string;
  answerLabel: string;
  answers: QuestionAnswers;
};

export type SubchatSuggestionOutcomeContext = {
  kind: "subchat-suggestion-outcome";
  id: string;
  fromTitle: string;
  outcome: "sent" | "answered" | "dismissed" | "cancelled";
  label?: string;
};

export type SubchatAnsweredByContext = { kind: "subchat-answered-by"; parentTitle: string; label: string };

/** In the parent: the message that starts a wake's turn. Nobody typed it, and the transcript draws nothing for it. */
export type SubchatWakeContext = { kind: "subchat-wake"; requests: { from: string; fromTitle: string; requestId: string }[] };

export function waitingNote(context: Pick<SubchatWaitingContext, "ask" | "parentTitle" | "waitedMs">): string;
export function escalationLine(context: Pick<SubchatEscalationContext, "fromTitle" | "waitedMs" | "paused">): string;
export function suggestionOutcomeLine(context: Pick<SubchatSuggestionOutcomeContext, "outcome" | "fromTitle" | "label">): string | null;
export function suggestionOutcomes(messages: readonly { context?: unknown }[]): Map<string, SubchatSuggestionOutcomeContext>;
export function isSubchatWake(message: { context?: unknown } | null | undefined): boolean;
export function ancestorChats(sessions: Record<string, { parent?: number }> | undefined, sessionId: number): number[];
