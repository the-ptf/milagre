import { useMemo, useRef } from "react";
import { doneFromReply } from "@milagre/shared/done";
import type { ComposerSession } from "../components/composer/chat-composer-props";

type Settle = (sessionId: number, snoozeUntil?: number) => void;

/** The transcript props that come from the open Chat: the usage-limit card's, and what the last reply's Done and Snooze
 * run (nothing while the agent works or once the Chat can't be marked Done). */
export function useTranscriptSession(session: ComposerSession | undefined, sending: boolean, settle: Settle | undefined) {
  const latest = useRef(settle);
  latest.current = settle;
  const settleId = session && settle && !sending && doneFromReply(session) ? session.id : undefined;
  const onSettle = useMemo(() => (settleId === undefined ? undefined : (snoozeUntil?: number) => latest.current?.(settleId, snoozeUntil)), [settleId]);
  return {
    limitPending: session?.limitResume,
    limitSourceMessageId: session?.limitTurn?.sourceMessageId,
    limitResumeBlocked: !!session?.queued?.length,
    onSettle,
  };
}
