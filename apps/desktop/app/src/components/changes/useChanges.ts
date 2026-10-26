import { isTurnEnd } from "@milagre/shared/agent-runs";
import { useCallback, useEffect, useState } from "react";
import type { ChangesMode, PrRange } from "../../lib/pull-request-view";
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
export function useChanges({
  cwd,
  base,
  chatId,
  available,
  pullRequest,
}: {
  cwd: string | undefined;
  base: string | undefined;
  chatId: string | null;
  available: boolean;
  /** The PR the Chat's branch opened, when it has one: its number for the mode menu and its commits for the diff. */
  pullRequest?: { number: number; range?: PrRange };
}) {
  const [open, setOpen] = useState(false);
  // The chat the diff (or the PR's review guide) was opened for; it only shows while that chat is the selected one.
  const [diffChatId, setDiffChatId] = useState<string | null>(null);
  const [guideChatId, setGuideChatId] = useState<string | null>(null);
  const [chosenMode, setMode] = useState<ChangesMode>("uncommitted");
  // A Chat without a PR shows its own changes, whatever was picked for another Chat.
  const mode: ChangesMode = chosenMode === "pr" && !pullRequest ? "uncommitted" : chosenMode;
  const [scrollTarget, setScrollTarget] = useState<{ path: string; nonce: number } | null>(null);
  const shown = open && available;
  const files = useDiffFiles({ cwd: cwd ?? "", base, mode, range: pullRequest?.range, active: shown, bridge: bridgeForKey(chatId) });
  const { refresh } = files;

  const diffOpen = shown && chatId !== null && diffChatId === chatId;
  const guideOpen = shown && mode === "pr" && chatId !== null && guideChatId === chatId && !diffOpen;

  // Hiding the panel closes the diff and the guide; reopening it starts on the chat.
  useEffect(() => {
    if (!shown) {
      setDiffChatId(null);
      setGuideChatId(null);
    }
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
  const closeDiff = useCallback(() => {
    setDiffChatId(null);
    setGuideChatId(null);
  }, []);
  const selectFile = useCallback(
    (path: string) => {
      setGuideChatId(null);
      setDiffChatId(chatId);
      setScrollTarget((previous) => ({ path, nonce: (previous?.nonce ?? 0) + 1 }));
    },
    [chatId],
  );
  /** Opens the panel on the Chat's PR (the sidebar's PR chip, the composer's Merge pill). */
  const showPullRequest = useCallback(() => {
    setMode("pr");
    setOpen(true);
  }, []);
  const openGuide = useCallback(() => {
    setDiffChatId(null);
    setGuideChatId(chatId);
  }, [chatId]);

  return {
    open: shown,
    toggle,
    diffOpen,
    guideOpen,
    openGuide,
    closeDiff,
    mode,
    setMode,
    showPullRequest,
    pullRequestNumber: pullRequest?.number,
    scrollTarget,
    activePath: diffOpen ? scrollTarget?.path : undefined,
    selectFile,
    ...files,
  };
}
