import { isTurnEnd } from "@milagre/shared/agent-runs";
import { useCallback, useEffect, useState } from "react";
import type { DiffMode } from "../../electron";
import type { ChangesMode, PrRange } from "../../lib/pull-request-view";
import { useComparison } from "./useComparison";
import { useDiffFiles } from "./useDiffFiles";
import { sectionOf } from "./ChangesPanel";
import { useCloseWhenDesignsExpand, useSidePanelRoom } from "../agents/dock-area";
import { usePanelWidth } from "../agents/panel-width";
import { bridgeForKey, onAnyAgentEvent } from "../../lib/computer-bridge";

export type Changes = ReturnType<typeof useChanges>;

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
  pullRequest?: { number: number; range?: PrRange };
  panelLists?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [diffChatId, setDiffChatId] = useState<string | null>(null);
  const [chosenMode, setMode] = useState<ChangesMode>("uncommitted");
  const mode: ChangesMode = chosenMode === "pr" && !pullRequest ? "uncommitted" : chosenMode;
  const [scrollTarget, setScrollTarget] = useState<{ path: string; nonce: number } | null>(null);
  const [visiblePath, setVisiblePath] = useState<string | null>(null);
  const shown = open && available;
  const bridge = bridgeForKey(chatId);
  const comparison = useComparison(cwd ?? "", base, bridge, shown && panelLists);
  const comparisonBase = comparison.base;
  const read = (readerMode: DiffMode) => ({ active: shown && (panelLists || mode === readerMode), patches: mode === readerMode, bridge });
  const uncommitted = useDiffFiles({ cwd: cwd ?? "", base, mode: "uncommitted", ...read("uncommitted") });
  const committed = useDiffFiles({ cwd: cwd ?? "", base: comparisonBase, mode: "committed", ...read("committed") });
  const pr = useDiffFiles({ cwd: cwd ?? "", base, mode: "pr", range: pullRequest?.range, active: shown && mode === "pr", patches: true, bridge });
  const files = mode === "pr" ? pr : mode === "committed" ? committed : uncommitted;
  const refreshPr = pr.refresh,
    refreshUncommitted = uncommitted.refresh,
    refreshCommitted = committed.refresh;
  const refreshComparison = comparison.refresh;
  const refresh = useCallback(
    async (background = false) => {
      await Promise.all([
        panelLists && refreshComparison(),
        (panelLists || mode === "uncommitted") && refreshUncommitted(background),
        (panelLists || mode === "committed") && refreshCommitted(background),
        mode === "pr" && refreshPr(background),
      ]);
    },
    [mode, panelLists, refreshPr, refreshUncommitted, refreshCommitted, refreshComparison],
  );

  const diffOpen = shown && chatId !== null && diffChatId === chatId;

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
  useSidePanelRoom("changes", shown, usePanelWidth("changes").width + 12, hide);
  const closeDiff = useCallback(() => setDiffChatId(null), []);
  const selectFile = useCallback(
    (path: string, fileMode?: DiffMode) => {
      if (fileMode) setMode(fileMode);
      setDiffChatId(chatId);
      setScrollTarget((previous) => ({ path, nonce: (previous?.nonce ?? 0) + 1 }));
      setVisiblePath(path);
    },
    [chatId],
  );
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
  const showPullRequest = useCallback(() => {
    setMode("pr");
    setOpen(true);
  }, []);
  return {
    open: shown,
    toggle,
    hide,
    diffOpen,
    closeDiff,
    mode,
    setMode,
    showPullRequest,
    pullRequestNumber: pullRequest?.number,
    scrollTarget,
    activePath: diffOpen ? (visiblePath ?? scrollTarget?.path) : undefined,
    setVisiblePath,
    selectFile,
    openFile,
    ...files,
    refresh,
    lists,
    comparison,
  };
}
