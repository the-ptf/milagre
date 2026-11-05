// The notes a Subchat's escalation leaves in transcripts (subchat-escalation.ts in shared): which message is which, and
// which ones read as nothing because something else says it better. Pure, so the Chat screen only draws.
import type {
  SubchatAnsweredByContext,
  SubchatEscalationContext,
  SubchatSuggestionContext,
  SubchatSuggestionOutcomeContext,
  SubchatWaitingContext,
} from "@milagre/shared/subchat-escalation";
import { isSubchatWake, suggestionOutcomes } from "@milagre/shared/subchat-escalation";

export type SubchatNote =
  | SubchatWaitingContext
  | SubchatEscalationContext
  | SubchatSuggestionContext
  | SubchatSuggestionOutcomeContext
  | SubchatAnsweredByContext;

const KINDS = new Set(["subchat-waiting", "subchat-escalation", "subchat-suggestion", "subchat-suggestion-outcome", "subchat-answered-by"]);

type Noted = { id: number | string; context?: unknown };

/** The escalation note a message carries, or null for any other message. */
export function subchatNote(message: Pick<Noted, "context">): SubchatNote | null {
  const context = message.context as { kind?: unknown } | null | undefined;
  return context && typeof context === "object" && typeof context.kind === "string" && KINDS.has(context.kind) ? (context as SubchatNote) : null;
}

/** A message that never draws in the transcript, whatever else is open: the wake's turn message and a suggestion's outcome. */
export function isSilentNote(message: Pick<Noted, "context">): boolean {
  return isSubchatWake(message) || subchatNote(message)?.kind === "subchat-suggestion-outcome";
}

/**
 * What the transcript draws of its notes, by message id:
 * - `outcomes`: what became of each suggestion, which its card shows instead of its buttons;
 * - `silent`: messages that draw nothing in place: the wake that started the parent's escalation turn (nobody typed it), an
 *   outcome (its card says it), an escalation line when a suggestion for
 *   the same request follows (the card says it better), and the open request's waiting note, which sits above its question
 *   card instead (`waiting`).
 * `requestPending` is whether the Chat has an open question or approval now.
 */
export function subchatNotes(messages: readonly Noted[], requestPending: boolean) {
  const outcomes = suggestionOutcomes(messages);
  const silent = new Set<Noted["id"]>();
  const suggested = new Set<string>();
  let waiting: SubchatWaitingContext | null = null;
  let waitingId: Noted["id"] | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (isSubchatWake(message)) {
      silent.add(message.id);
      continue;
    }
    const note = subchatNote(message);
    if (!note) continue;
    if (note.kind === "subchat-suggestion") suggested.add(note.requestId);
    else if (note.kind === "subchat-escalation" && suggested.has(note.requestId)) silent.add(message.id);
    else if (note.kind === "subchat-suggestion-outcome") silent.add(message.id);
    else if (note.kind === "subchat-waiting" && waitingId === undefined) {
      waitingId = message.id;
      waiting = note;
    }
  }
  // Only the latest waiting note belongs to the open request; an older one, or any once it is answered, stays where it was.
  if (requestPending && waitingId !== undefined) silent.add(waitingId);
  return { outcomes, silent, waiting: requestPending ? waiting : null };
}

/** The arguments of `agent:answer-question` for the Send answer button: the answer is the suggestion's, tagged with its id. */
export function suggestionArguments(note: SubchatSuggestionContext) {
  return { chatId: note.from, requestId: note.requestId, answers: note.answers, summary: `${note.question}: ${note.answerLabel}`, suggestionId: note.id };
}
