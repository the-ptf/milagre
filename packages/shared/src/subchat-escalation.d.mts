import type { QuestionAnswers } from "./model.ts";

export const ESCALATION_WAIT_MS: number;
export const ESCALATION_COOLDOWN_MS: number;
export const ESCALATION_MAX_WAKES: number;
export const ESCALATION_BATCH_MS: number;
export const ESCALATION_TOOL_CALLS: number;
export const ESCALATION_TOOL_GRACE: number;

/** In the Subchat, above its question: the wait, and that the Chat above knows. */
export type SubchatWaitingContext = { kind: "subchat-waiting"; ask: "question" | "approval"; parentTitle: string; waitedMs: number };

/** In the parent: the line that opens the waiting Subchat. `paused` once the family's wakes are spent. */
export type SubchatEscalationContext = { kind: "subchat-escalation"; from: string; fromTitle: string; requestId: string; waitedMs: number; paused?: boolean };

/** In the parent: an agent's suggested answer, for the user to send. */
export type SubchatSuggestionContext = {
  kind: "subchat-suggestion";
  id: string;
  from: string;
  fromTitle: string;
  requestId: string;
  question: string;
  /** The picked labels or typed text, as the answer reads. */
  answerLabel: string;
  answers: QuestionAnswers;
};

/** In the parent: what became of suggestion `id`. `label` is the answer that went in, when one did. */
export type SubchatSuggestionOutcomeContext = {
  kind: "subchat-suggestion-outcome";
  id: string;
  fromTitle: string;
  outcome: "sent" | "answered" | "dismissed" | "cancelled";
  label?: string;
};

/** In the Subchat: the Chat above answered in Full. */
export type SubchatAnsweredByContext = { kind: "subchat-answered-by"; parentTitle: string; label: string };

/** In the parent: the message that starts a wake's turn. Nobody typed it, and the transcript draws nothing for it. */
export type SubchatWakeContext = { kind: "subchat-wake"; requests: { from: string; fromTitle: string; requestId: string }[] };

export function waitingNote(context: Pick<SubchatWaitingContext, "ask" | "parentTitle" | "waitedMs">): string;
export function escalationLine(context: Pick<SubchatEscalationContext, "fromTitle" | "waitedMs" | "paused">): string;
export function suggestionOutcomeLine(context: Pick<SubchatSuggestionOutcomeContext, "outcome" | "fromTitle" | "label">): string | null;
export function suggestionOutcomes(messages: readonly { context?: unknown }[]): Map<string, SubchatSuggestionOutcomeContext>;
export function isSubchatWake(message: { context?: unknown } | null | undefined): boolean;
export function ancestorChats(sessions: Record<string, { parent?: number }> | undefined, sessionId: number): number[];
