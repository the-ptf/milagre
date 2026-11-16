import { useEffect, useState } from "react";
import type { LinkedWork } from "../model";
import { chatInProject, sessionIdFromKey } from "@milagre/shared/agent-runs";

export const NO_LINKED_WORK: LinkedWork = { delegations: [], negotiations: [], receiveOnly: [] };

export function useLinkedWork(): LinkedWork {
  const [work, setWork] = useState<LinkedWork>(NO_LINKED_WORK);
  useEffect(() => {
    let live = true;
    window.milagre.getLinkedWork().then(
      (next) => {
        // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
        if (live) setWork(next);
      },
      () => {},
    );
    const off = window.milagre.onLinkedWork(setWork);
    return () => {
      live = false;
      off();
    };
  }, []);
  return work;
}

export function delegatedChats(work: LinkedWork, projectPath: string): Set<number> {
  return new Set(work.delegations.flatMap((item) => (item.to_chat && chatInProject(projectPath, item.to_chat) ? [sessionIdFromKey(item.to_chat)] : [])));
}
