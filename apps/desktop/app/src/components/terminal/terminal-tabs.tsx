import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dockLayer, useDockArea } from "../agents/dock-area";
import { sessionIdFromKey } from "../../lib/agent-runs";
import { setTerminalPanelOpen, showTerminal } from "../../lib/terminal-store";
import { requestTab, useStage, useWorkspaceTabsOn } from "../../lib/workspace-stage";

/**
 * With Workspace tabs, a Chat's Terminals show while one of their tabs is in front instead of with the panel's toggle;
 * the toggle (⌘J, the + menu) brings the Terminal's tab forward.
 */
export function useTerminalTabs(chatId: string | null, panelOpen: boolean, active: string | null) {
  const tabsOn = useWorkspaceTabsOn();
  const stage = useStage();
  const staged = tabsOn && stage?.tab.kind === "terminal" && stage.chatKey === chatId ? stage : null;
  const stagedTerminal = staged?.tab.kind === "terminal" ? staged.tab.terminalId : null;
  useEffect(() => {
    if (chatId && stagedTerminal && active !== stagedTerminal) showTerminal(chatId, stagedTerminal);
  }, [chatId, stagedTerminal, active]);
  useEffect(() => {
    if (!tabsOn || !chatId || !panelOpen) return;
    setTerminalPanelOpen(chatId, false);
    if (active) requestTab(chatId, { kind: "terminal", chatId: sessionIdFromKey(chatId), terminalId: active }, true);
  }, [tabsOn, chatId, panelOpen, active]);
  return { open: tabsOn ? !!staged : panelOpen, staged };
}

/** A Terminal whose Workspace tab is in front, filling the workspace where the Chat was. */
export function TerminalStage({ children }: { children: ReactNode }) {
  const dock = useDockArea();
  return createPortal(
    <div
      data-terminal-stage
      className="fixed z-[41] flex flex-col"
      style={{
        top: dock?.top ?? 40,
        left: dock?.left ?? 0,
        right: `calc(${(dock?.right ?? 0) + 12}px + var(--simulator-dock, 0px))`,
        bottom: dock?.bottom ?? 12,
      }}
    >
      {children}
    </div>,
    dockLayer(),
  );
}
