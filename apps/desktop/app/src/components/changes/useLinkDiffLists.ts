import { useCallback, useEffect, useRef, useState } from "react";
import { useGitRefresh } from "./useGitRefresh";
import { isTurnEnd } from "@milagre/shared/agent-runs";
import type { WorktreeBinding } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { DiffMode } from "../../electron";
import type { DiffList } from "./useDiffFiles";
import { bridgeForKey, onAnyAgentEvent } from "../../lib/computer-bridge";

/** Read every owned Worktree, retaining independent errors and never showing an earlier Chat's lists. */
export function useLinkDiffLists({ members, chatId, mode, active }: { members: WorktreeBinding[]; chatId: string | null; mode: DiffMode; active: boolean }) {
  const identity = JSON.stringify([chatId, mode, members]);
  const [snapshot, setSnapshot] = useState<{ identity: string; lists: Record<string, DiffList>; loading: boolean }>({
    identity: "",
    lists: {},
    loading: false,
  });
  const generation = useRef(0);
  const request = useRef({ identity, members, mode, chatId });
  request.current = { identity, members, mode, chatId };
  const refresh = useCallback(async () => {
    const { identity, members, mode, chatId } = request.current;
    const current = ++generation.current;
    setSnapshot((previous) => ({ identity, lists: previous.identity === identity ? previous.lists : {}, loading: true }));
    await Promise.all(
      members.map(async (member) => {
        let list: DiffList;
        try {
          list = { state: "ready", ...(await bridgeForKey(chatId).git.diffFiles({ cwd: member.worktreePath, base: member.base, mode })) };
        } catch (error) {
          list = { state: "error", message: ipcErrorMessage(error) };
        }
        if (current === generation.current) setSnapshot((previous) => ({ ...previous, lists: { ...previous.lists, [member.projectId]: list } }));
      }),
    );
    if (current === generation.current) setSnapshot((previous) => ({ ...previous, loading: false }));
  }, []);
  useEffect(() => {
    return () => {
      generation.current++;
    };
  }, [active, identity, refresh]);
  useGitRefresh(active, identity, refresh);
  useEffect(() => {
    if (!active || !chatId) return;
    return onAnyAgentEvent((message) => {
      if (message.chatId === chatId && isTurnEnd(message.event)) void refresh();
    });
  }, [active, chatId, refresh]);
  return { lists: snapshot.identity === identity ? snapshot.lists : {}, loading: snapshot.identity !== identity || snapshot.loading, refresh };
}
