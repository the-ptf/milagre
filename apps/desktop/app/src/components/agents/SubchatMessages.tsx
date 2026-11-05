import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CornerDownRightIcon } from "@hugeicons/core-free-icons";
import {
  escalationLine,
  suggestionOutcomeLine,
  type SubchatEscalationContext,
  type SubchatSuggestionContext,
  type SubchatSuggestionOutcomeContext,
} from "@milagre/shared/subchat-escalation";
import { chatKey } from "@milagre/shared/agent-runs";
import type { QuestionAnswers } from "../../model";
import { useScope } from "../../lib/computer-bridge";
import { pendingWaitingNote, subchatNote } from "../../lib/subchat-transcript";
import { Button } from "../primitives/Button";
import { InlineError } from "../primitives/InlineError";

/** What the suggestion card's buttons do, which App provides for every Chat on screen (a transcript has no other way to reach the agent runs). */
export interface SubchatActions {
  /** Sends the suggested answer to the waiting Subchat as the user's own; the host marks the card sent. False when the question is gone. */
  sendSuggestion: (subchat: string, requestId: string, answers: QuestionAnswers, suggestionId: string) => Promise<boolean>;
  /** Removes the card from the parent `chat`; the question stays open in the Subchat. */
  dismissSuggestion: (chat: string, id: string) => Promise<boolean>;
}

let actions: SubchatActions | null = null;

/** App hands over the actions while it is mounted; returns what takes them back. */
export function provideSubchatActions(next: SubchatActions) {
  actions = next;
  return () => {
    if (actions === next) actions = null;
  };
}

/** A grey `↳` line, as a Delegation's report is, whose text (when it has a Chat to open) is a link. */
function NoteLine({
  text,
  chat,
  onOpenChat,
  ...data
}: { text: string; chat?: string; onOpenChat?: (chatKey: string) => void } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5 text-12 text-ink-3" {...data}>
      <HugeiconsIcon icon={CornerDownRightIcon} size={12} strokeWidth={1.6} className="shrink-0" aria-hidden />
      {chat && onOpenChat ? (
        <button
          type="button"
          data-linked-from={chat}
          onClick={() => onOpenChat(chat)}
          className="min-w-0 truncate rounded-inline hover:underline focus-visible:outline-2"
        >
          {text}
        </button>
      ) : (
        <span className="min-w-0 truncate">{text}</span>
      )}
    </div>
  );
}

/**
 * A Subchat escalation's note in a transcript: the `↳` line that opens the waiting Subchat, the grey line that says the Chat
 * above answered, a suggestion's card, or what became of one. Null for a message that is none of these; the transcript has
 * already left out the notes it draws elsewhere (hiddenSubchatNotes).
 */
export function SubchatMessage({
  message,
  outcomes,
  onOpenChat,
}: {
  message: { id: number; session_id: number; context?: unknown };
  outcomes: ReadonlyMap<string, SubchatSuggestionOutcomeContext>;
  onOpenChat?: (chatKey: string) => void;
}) {
  const note = subchatNote(message);
  if (!note) return null;
  if (note.kind === "subchat-escalation") return <EscalationLine note={note} onOpenChat={onOpenChat} />;
  if (note.kind === "subchat-answered-by") return <NoteLine data-slot="subchat-answered-by" text={`Answered by ${note.parentTitle}`} />;
  if (note.kind === "subchat-suggestion")
    return <SuggestionCard note={note} sessionId={message.session_id} outcome={outcomes.get(note.id)} onOpenChat={onOpenChat} />;
  return null;
}

function EscalationLine({ note, onOpenChat }: { note: SubchatEscalationContext; onOpenChat?: (chatKey: string) => void }) {
  return <NoteLine data-slot="subchat-escalation" text={escalationLine(note)} chat={note.from} onOpenChat={onOpenChat} />;
}

function SuggestionCard({
  note,
  sessionId,
  outcome,
  onOpenChat,
}: {
  note: SubchatSuggestionContext;
  sessionId: number;
  outcome?: SubchatSuggestionOutcomeContext;
  onOpenChat?: (chatKey: string) => void;
}) {
  const scope = useScope();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // With an outcome the card is over: its words, or nothing when the user dismissed it.
  if (outcome) {
    const line = suggestionOutcomeLine(outcome);
    return line ? <NoteLine data-slot="subchat-suggestion-outcome" text={line} /> : null;
  }
  const run = (action: () => Promise<boolean>, error: string) => {
    setBusy(true);
    setFailed(null);
    // False means the request is gone: its outcome note arrives and replaces this card.
    action()
      .catch(() => setFailed(error))
      .finally(() => setBusy(false));
  };
  const parent = scope ? chatKey(scope, sessionId) : null;
  return (
    <section
      data-slot="subchat-suggestion"
      aria-label={`Suggested answer for ${note.fromTitle}`}
      className="flex min-w-0 flex-col gap-2 rounded-card border border-line px-3 py-3"
    >
      <p className="min-w-0 truncate text-12 text-ink-3">
        {note.fromTitle} · {note.question}
      </p>
      <p className="text-13 text-ink">Send &ldquo;{note.answerLabel}&rdquo; as your answer?</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          disabled={busy}
          data-suggestion-send
          onClick={() => {
            const current = actions;
            if (current) run(() => current.sendSuggestion(note.from, note.requestId, note.answers, note.id), "Could not send the answer.");
          }}
        >
          Send answer
        </Button>
        <Button variant="secondary" data-suggestion-open disabled={!onOpenChat} onClick={() => onOpenChat?.(note.from)}>
          Open Subchat
        </Button>
        <Button
          variant="ghost"
          data-suggestion-dismiss
          disabled={busy || !parent}
          onClick={() => {
            const current = actions;
            if (current && parent) run(() => current.dismissSuggestion(parent, note.id), "Could not dismiss the card.");
          }}
        >
          Dismiss
        </Button>
      </div>
      {failed && <InlineError size={12}>{failed}</InlineError>}
    </section>
  );
}

/**
 * The note above the docked question or approval card: how long the Subchat has waited and who was told. It belongs to the
 * request the card shows, so it appears only for the card of the kind it names.
 */
export function SubchatWaitingNote({
  messages,
  ask,
}: {
  messages: readonly { id: number; role?: "user" | "assistant"; context?: unknown }[];
  ask: "question" | "approval";
}) {
  const note = pendingWaitingNote(messages);
  if (!note || note.ask !== ask) return null;
  return (
    <p data-slot="subchat-waiting" className="px-1 text-12 text-ink-3">
      {note.text}
    </p>
  );
}
