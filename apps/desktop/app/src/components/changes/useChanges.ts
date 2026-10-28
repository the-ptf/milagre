import { isTurnEnd } from "@milagre/shared/agent-runs";
import { useCallback, useEffect, useState } from "react";
import type { DiffMode } from "../../electron";
import type { ChangesMode, PrRange } from "../../lib/pull-request-view";
import { useDiffFiles } from "./useDiffFiles";
import { sectionOf } from "./ChangesPanel";
import { useCloseWhenDesignsExpand, useSidePanelRoom } from "../agents/dock-area";
import { usePanelWidth } from "../agents/panel-width";
import { bridgeForKey, onAnyAgentEvent } from "../../lib/computer-bridge";

export type Changes = ReturnType<typeof useChanges>;

/**
 * Everything the Changes panel and the diff view share: whether the panel is open, whether the diff
 * replaces the chat, the mode, and the file lists. `mode` is what the diff shows; the panel's Changes tab lists both
 * the uncommitted and the committed files (`lists`), and opening one switches the diff to its mode. `chatId` is the
 * selected chat's key; its turn ending re-reads the lists, the same moment the sidebar's diff stats refresh.
 */
export function useChanges({
  cwd,
  base,
  chatId,
  available,
  pullRequest,
  panelLists = true,
}: {
  cwd: string | undefined;
  base: string | undefined;
  chatId: string | null;
  available: boolean;
  /** The PR the Chat's branch opened, when it has one: its number for its tab and its commits for the diff. */
  pullRequest?: { number: number; range?: PrRange };
  /** Whether the panel lists `lists`; a Link's panel reads its own, so only the diff's mode is read here. */
  panelLists?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The chat the diff was opened for; it only shows while that chat is the selected one.
  const [diffChatId, setDiffChatId] = useState<string | null>(null);
  const [chosenMode, setMode] = useState<ChangesMode>("uncommitted");
  // A Chat without a PR shows its own changes, whatever was picked for another Chat.
  const mode: ChangesMode = chosenMode === "pr" && !pullRequest ? "uncommitted" : chosenMode;
  const [scrollTarget, setScrollTarget] = useState<{ path: string; nonce: number } | null>(null);
  const shown = open && available;
  const bridge = bridgeForKey(chatId);
  // One reader per mode, so switching between them keeps each list. The Changes tab's count shows on the PR tab too,
  // so both lists stay read while the panel is open; only the diff's mode keeps its loaded patches current.
  const read = (readerMode: DiffMode) => ({ active: shown && (panelLists || mode === readerMode), patches: mode === readerMode, bridge });
  const uncommitted = useDiffFiles({ cwd: cwd ?? "", base, mode: "uncommitted", ...read("uncommitted") });
  const committed = useDiffFiles({ cwd: cwd ?? "", base, mode: "committed", ...read("committed") });
  const pr = useDiffFiles({ cwd: cwd ?? "", base, mode: "pr", range: pullRequest?.range, active: shown && mode === "pr", patches: true, bridge });
  const files = mode === "pr" ? pr : mode === "committed" ? committed : uncommitted;
  const refreshPr = pr.refresh,
    refreshUncommitted = uncommitted.refresh,
    refreshCommitted = committed.refresh;
  const refresh = useCallback(
    async (background = false) => {
      await Promise.all([
        (panelLists || mode === "uncommitted") && refreshUncommitted(background),
        (panelLists || mode === "committed") && refreshCommitted(background),
        mode === "pr" && refreshPr(background),
      ]);
    },
    [mode, panelLists, refreshPr, refreshUncommitted, refreshCommitted],
  );

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
  const hasPr = Boolean(pullRequest);
  /** The Changes button and its shortcut: the panel opens on the Chat's PR when it has one, on its changes otherwise. */
  const toggleDefault = useCallback(() => {
    if (!open && hasPr) setMode("pr");
    setOpen(!open);
  }, [open, hasPr]);
  const hide = useCallback(() => setOpen(false), []);
  useCloseWhenDesignsExpand(hide);
  // The panel's dragged width, plus the 12px gap beside it.
  useSidePanelRoom("changes", shown, usePanelWidth("changes").width + 12, hide);
  const closeDiff = useCallback(() => setDiffChatId(null), []);
  /** Opens a file's diff; `fileMode` is the Changes tab's section it was picked in. */
  const selectFile = useCallback(
    (path: string, fileMode?: DiffMode) => {
      if (fileMode) setMode(fileMode);
      setDiffChatId(chatId);
      setScrollTarget((previous) => ({ path, nonce: (previous?.nonce ?? 0) + 1 }));
    },
    [chatId],
  );
  // A file opened from outside the panel (a transcript's link) goes to the section that lists it, once both are read.
  const [placing, setPlacing] = useState<string | null>(null);
  const lists = { uncommitted: uncommitted.list, committed: committed.list };
  const settled = (list: typeof uncommitted.list) => list.state === "ready" || list.state === "error";
  const placed = placing !== null && settled(uncommitted.list) && settled(committed.list) ? sectionOf(lists, placing) : null;
  useEffect(() => {
    if (!placed) return;
    setMode(placed);
    setPlacing(null);
  }, [placed]);
  const openFile = useCallback(
    (path: string) => {
      setPlacing(path);
      selectFile(path, "uncommitted");
    },
    [selectFile],
  );
  /** Opens the panel on the Chat's PR (the sidebar's PR chip, the composer's Merge pill). */
  const showPullRequest = useCallback(() => {
    setMode("pr");
    setOpen(true);
  }, []);
  return {
    open: shown,
    toggle,
    toggleDefault,
    diffOpen,
    closeDiff,
    mode,
    setMode,
    showPullRequest,
    pullRequestNumber: pullRequest?.number,
    scrollTarget,
    activePath: diffOpen ? scrollTarget?.path : undefined,
    selectFile,
    openFile,
    ...files,
    refresh,
    lists,
  };
}
