import { isTurnEnd } from "@milagre/shared/agent-runs";
import { useCallback, useEffect, useState } from "react";
import type { DiffMode } from "../../electron";
import { useDiffFiles } from "./useDiffFiles";
import { useCloseWhenDesignsExpand, useSidePanelRoom } from "../agents/dock-area";
import { usePanelWidth } from "../agents/panel-width";
import { bridgeForKey, onAnyAgentEvent } from "../../lib/computer-bridge";

export type Changes = ReturnType<typeof useChanges>;

/**
 * Everything the Changes panel and the diff view share: whether the panel is open, whether the diff
 * replaces the chat, the mode, and the file list. `chatId` is the selected chat's key; its turn ending re-reads the list,
 * the same moment the sidebar's diff stats refresh.
 */
export function useChanges({ cwd, base, chatId, available }: { cwd: string | undefined; base: string | undefined; chatId: string | null; available: boolean }) {
  const [open, setOpen] = useState(false);
  // The chat the diff was opened for; it only shows while that chat is the selected one.
  const [diffChatId, setDiffChatId] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("uncommitted");
  const [scrollTarget, setScrollTarget] = useState<{ path: string; nonce: number } | null>(null);
  const shown = open && available;
  const files = useDiffFiles({ cwd: cwd ?? "", base, mode, active: shown, bridge: bridgeForKey(chatId) });
  const { refresh } = files;

  const diffOpen = shown && chatId !== null && diffChatId === chatId;

  // Hiding the panel closes the diff; reopening it starts on the chat.
  useEffect(() => {
    if (!shown) setDiffChatId(null);
  }, [shown]);

  useEffect(() => {
    if (!shown || !chatId) return;
    return onAnyAgentEvent((message) => {
      if (message.chatId !== chatId) return;
      if (isTurnEnd(message.event)) void refresh();
    });
  }, [shown, chatId, refresh]);

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const hide = useCallback(() => setOpen(false), []);
  useCloseWhenDesignsExpand(hide);
  // The panel's dragged width, plus the 12px gap beside it.
  useSidePanelRoom("changes", shown, usePanelWidth("changes").width + 12, hide);
  const closeDiff = useCallback(() => setDiffChatId(null), []);
  const selectFile = useCallback(
    (path: string) => {
      setDiffChatId(chatId);
      setScrollTarget((previous) => ({ path, nonce: (previous?.nonce ?? 0) + 1 }));
    },
    [chatId],
  );

  return { open: shown, toggle, diffOpen, closeDiff, mode, setMode, scrollTarget, activePath: diffOpen ? scrollTarget?.path : undefined, selectFile, ...files };
}
