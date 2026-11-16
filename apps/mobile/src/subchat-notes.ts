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

export function subchatNote(message: Pick<Noted, "context">): SubchatNote | null {
  const context = message.context as { kind?: unknown } | null | undefined;
  return context && typeof context === "object" && typeof context.kind === "string" && KINDS.has(context.kind) ? (context as SubchatNote) : null;
}

export function isSilentNote(message: Pick<Noted, "context">): boolean {
  return isSubchatWake(message) || subchatNote(message)?.kind === "subchat-suggestion-outcome";
}

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
  if (requestPending && waitingId !== undefined) silent.add(waitingId);
  return { outcomes, silent, waiting: requestPending ? waiting : null };
}

export function suggestionArguments(note: SubchatSuggestionContext) {
  return { chatId: note.from, requestId: note.requestId, answers: note.answers, summary: `${note.question}: ${note.answerLabel}`, suggestionId: note.id };
}
