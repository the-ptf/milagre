import {
  isSubchatWake,
  waitingNote,
  type SubchatAnsweredByContext,
  type SubchatEscalationContext,
  type SubchatSuggestionContext,
  type SubchatSuggestionOutcomeContext,
  type SubchatWaitingContext,
} from "@milagre/shared/subchat-escalation";

type Message = { id: number; role?: "user" | "assistant"; context?: unknown };

export type SubchatNote =
  | SubchatEscalationContext
  | SubchatSuggestionContext
  | SubchatSuggestionOutcomeContext
  | SubchatAnsweredByContext
  | SubchatWaitingContext;

const KINDS = new Set(["subchat-escalation", "subchat-suggestion", "subchat-suggestion-outcome", "subchat-answered-by", "subchat-waiting"]);

export function subchatNote(message: Pick<Message, "context">): SubchatNote | null {
  const context = message.context as { kind?: unknown } | null | undefined;
  return context && typeof context === "object" && typeof context.kind === "string" && KINDS.has(context.kind) ? (context as SubchatNote) : null;
}

export function hiddenSubchatNotes(messages: readonly Message[]): Set<number> {
  const hidden = new Set<number>();
  const suggested = new Set<string>();
  for (const message of messages.toReversed()) {
    if (isSubchatWake(message)) hidden.add(message.id);
    const note = subchatNote(message);
    if (!note) continue;
    if (note.kind === "subchat-suggestion") suggested.add(note.requestId);
    else if (note.kind === "subchat-suggestion-outcome" || note.kind === "subchat-waiting") hidden.add(message.id);
    else if (note.kind === "subchat-escalation" && suggested.has(note.requestId)) hidden.add(message.id);
  }
  return hidden;
}

export function pendingWaitingNote(messages: readonly Message[]): { ask: "question" | "approval"; text: string } | null {
  for (const message of messages.toReversed()) {
    const note = subchatNote(message);
    if (note?.kind === "subchat-waiting") return { ask: note.ask, text: waitingNote(note) };
    if (!note && message.role === "user" && !isSubchatWake(message)) return null;
  }
  return null;
}
