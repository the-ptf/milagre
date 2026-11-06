// What the notes a Subchat's escalation leaves (shared subchat-escalation.ts) mean for a transcript: which message is which
// kind, which escalation lines a suggestion makes redundant, and the waiting note that belongs above the docked card.
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

/** The escalation note a message is, or null for any other message. */
export function subchatNote(message: Pick<Message, "context">): SubchatNote | null {
  const context = message.context as { kind?: unknown } | null | undefined;
  return context && typeof context === "object" && typeof context.kind === "string" && KINDS.has(context.kind) ? (context as SubchatNote) : null;
}

/**
 * The messages whose note the transcript doesn't draw in its own place: an outcome is read by its card (suggestionOutcomes),
 * the waiting note sits above the docked question, an escalation line is dropped once a suggestion for the same request
 * follows it, so the screen doesn't say the same thing twice, and the wake's turn message is the host's, not the user's.
 */
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

/**
 * The waiting note of the request the docked card shows, with what it was about: the latest one, as long as nobody has
 * written in this Chat since. An answer or a message of the user's ends the wait, so an older note never sits over a newer card.
 */
export function pendingWaitingNote(messages: readonly Message[]): { ask: "question" | "approval"; text: string } | null {
  for (const message of messages.toReversed()) {
    const note = subchatNote(message);
    if (note?.kind === "subchat-waiting") return { ask: note.ask, text: waitingNote(note) };
    if (!note && message.role === "user" && !isSubchatWake(message)) return null;
  }
  return null;
}
