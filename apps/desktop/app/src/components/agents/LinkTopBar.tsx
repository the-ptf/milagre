import { workspaceKey } from "@milagre/shared/workspace-tabs";
import { useSettings } from "../../lib/settings";
import type { SidebarRecent } from "../sidebar/ChatRow";
import { useTabMenu } from "./ChatTopBar";
import { CanvasButton, ChangesToggle } from "../changes/ChangesChrome";
import { CORNER_PITCH, cornerButtonCount, PanelToggles, useSidePanels } from "./PanelToggles";
import type { TabSession } from "./use-workspace-tab-sources";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip";

/**
 * A Link's Workspace tabs: one tab set for the Link, holding its Chats and the pages they open. The Link view's top bar
 * also carries the Canvas button and, while a Chat is open, the Changes toggle, so the strip stops before both.
 */
export function LinkTabStrip({
  owner,
  state,
  rows,
  chat,
  changes,
  toggle,
  pick,
}: {
  owner: string;
  state: { sessions: Record<string, TabSession> };
  rows: readonly SidebarRecent[];
  chat: TabSession | undefined;
  changes: { open: boolean; diffOpen: boolean };
  toggle: () => void;
  pick: (chatId: number | null) => void;
}) {
  const { workspaceTabs } = useSettings();
  const activeChatId = chat?.id ?? null;
  const panels = activeChatId === null ? {} : { changes: { open: changes.open, toggle } };
  const menu = useTabMenu(panels);
  const shown = useSidePanels();
  if (!workspaceTabs || changes.diffOpen) return null;
  return (
    <WorkspaceTabStrip
      workspace={workspaceKey(owner, "link", 0)}
      projectPath={owner}
      panels={panels}
      sessions={state.sessions}
      belongs={() => true}
      rows={rows}
      activeChatId={activeChatId}
      corner={cornerButtonCount(false, shown, activeChatId !== null, null, "chat") * CORNER_PITCH}
      menu={menu}
      onOpenChat={pick}
      onNewChat={() => pick(null)}
    />
  );
}

/** The Link view's corner: the Canvas button, the Changes toggle while a Chat is open, and the panel toggles beside them. */
export function LinkCornerButtons({
  canvasOpen,
  onCanvas,
  chat,
  changes,
  toggle,
}: {
  canvasOpen: boolean;
  onCanvas: (open: boolean) => void;
  chat: TabSession | undefined;
  changes: { open: boolean; closeDiff: () => void };
  toggle: () => void;
}) {
  const changesShown = !canvasOpen && chat !== undefined;
  return (
    <>
      <CanvasButton
        active={canvasOpen}
        onToggle={() => {
          changes.closeDiff();
          onCanvas(!canvasOpen);
        }}
      />
      {changesShown && <ChangesToggle open={changes.open} onToggle={toggle} offset={1} />}
      <PanelToggles right={changesShown ? 12 + 2 * CORNER_PITCH : 12 + CORNER_PITCH} />
    </>
  );
}
