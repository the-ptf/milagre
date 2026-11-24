import { doneFromReply } from "@milagre/shared/done";
import type { ComposerSession } from "../components/composer/chat-composer-props";

/** What the last reply's Done button runs: nothing while the agent works or once the Chat can't be marked Done. */
export function replyDoneAction(session: ComposerSession | undefined, sending: boolean, mark: ((sessionId: number) => void) | undefined) {
  return session && mark && !sending && doneFromReply(session) ? () => mark(session.id) : undefined;
}

/** The usage-limit card props the transcript reads from the open Chat. */
export const limitProps = (session: ComposerSession | undefined) => ({
  limitPending: session?.limitResume,
  limitSourceMessageId: session?.limitTurn?.sourceMessageId,
  limitResumeBlocked: !!session?.queued?.length,
});
