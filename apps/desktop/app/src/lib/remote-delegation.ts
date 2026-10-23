import { useCallback, useEffect, useState } from "react";
import type { AgentRun } from "@milagre/shared/agent-runs";
import type { LinkedWork, OpenDelegation } from "../model";

type State = { enabled: boolean; ready: boolean; saving: boolean; error: string };

/** Settings > Experimental's "Delegate to other computers": this Mac's own switch, kept by its daemon. */
export function useRemoteDelegationEnabled() {
  const [state, setState] = useState<State>({ enabled: false, ready: false, saving: false, error: "" });
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const value = await window.milagre.readRemoteDelegationEnabled();
        if (live) setState((current) => ({ ...current, enabled: value?.enabled === true, ready: true }));
      } catch {
        if (live) setState((current) => ({ ...current, ready: true, error: "Could not read this setting." }));
      }
    };
    void read();
    const off = window.milagre.onRemoteDelegationEnabledChanged((value) =>
      setState((current) => ({ ...current, enabled: value?.enabled === true, ready: true, error: "" })),
    );
    return () => {
      live = false;
      off();
    };
  }, []);
  const save = useCallback(async (enabled: boolean) => {
    setState((current) => ({ ...current, saving: true, error: "" }));
    try {
      const result = await window.milagre.saveRemoteDelegationEnabled(enabled);
      setState((current) => ({ ...current, enabled: result.enabled === true }));
    } catch (cause) {
      setState((current) => ({ ...current, error: cause instanceof Error ? cause.message : "Could not change this setting." }));
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, []);
  return { ...state, save };
}

/** The Delegations a Chat sent to other computers that are still open: the Chat mirrors each one's turn. */
export function remoteDelegationsFrom(work: LinkedWork, chatKey: string | null): OpenDelegation[] {
  if (!chatKey) return [];
  return work.delegations.filter((item) => item.computer && item.from_chat === chatKey);
}

export type RemoteRunStatus = "sending" | "starting" | "approval" | "question" | "working";

/** What a mirrored turn is doing, from the other computer's live run (absent until its turn starts). */
export function remoteRunStatus(delegation: OpenDelegation, run: AgentRun | undefined): RemoteRunStatus {
  if (!delegation.to_chat) return "sending";
  if (!run) return "starting";
  if (run.approvals.length) return "approval";
  if (run.questions.length) return "question";
  return "working";
}

const TAIL = 600;
/** The end of what the mirrored turn has written so far, cut at a line or word start. */
export function replyTail(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= TAIL) return trimmed;
  const tail = trimmed.slice(-TAIL);
  const cut = Math.max(tail.indexOf("\n"), tail.indexOf(" "));
  return `…${cut >= 0 && cut < 80 ? tail.slice(cut + 1) : tail}`;
}
