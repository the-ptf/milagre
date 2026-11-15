import { useEffect, useRef, useState } from "react";
import { createResendMemory } from "@milagre/shared/chats";
import { sendPendingReducer, type FailedSend, type PendingSend, type PendingSendAction, type PreparedSendTarget } from "../lib/send-pending";
import type { CoordinatorState } from "../model";

/**
 * The sends on their way and the ones that failed, with the guards around them: `sendsInFlight` keeps Enter from
 * sending one Chat's message twice, `movingDraft` holds Enter while a new Chat's draft moves to another Project,
 * `failedSendIds` lets a resend of the same text reuse the id of one the host may have saved, and `preparedTarget`
 * keeps the Worktree a send set up so a retry goes there.
 */
export function useSendPipeline(states: Record<string, CoordinatorState>) {
  const sendsInFlight = useRef(new Set<string>());
  const movingDraft = useRef(false);
  const failedSendIds = useRef(createResendMemory());
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  const preparedTarget = useRef<PreparedSendTarget | null>(null);
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);
  const [restoringSend, setRestoringSend] = useState<FailedSend | null>(null);
  const dispatchPending = (action: PendingSendAction) => setPendingSends((current) => sendPendingReducer(current, action));
  useEffect(() => {
    setPendingSends((current) => sendPendingReducer(current, { type: "prune", states }));
  }, [pendingSends, states]);
  return {
    sendsInFlight,
    movingDraft,
    failedSendIds,
    pendingSends,
    dispatchPending,
    preparedTarget,
    failedSends,
    setFailedSends,
    restoringSend,
    setRestoringSend,
  };
}
