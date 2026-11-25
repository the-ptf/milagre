import { useEffect } from "react";
import { sessionIdFromKey } from "../../lib/agent-runs";
import { requestClose, requestTab, useStage, useWorkspaceTabsOn } from "../../lib/workspace-stage";
import type { DockPage } from "./dock-feedback";

/**
 * With Workspace tabs, a Chat's designs show while their tab is in front: opening them (a card, the agent starting a
 * design) asks for the tab, unread when the agent did it, and the tab coming forward opens its page; the panel shows only
 * while its tab is in front.
 */
export function useDesignsStage(
  chatId: string | null,
  opened: { page: DockPage; focus: { nonce: number }; agent?: boolean } | null,
  open: (page: DockPage) => void,
): DesignsStage {
  const tabsOn = useWorkspaceTabsOn();
  const stage = useStage();
  const staged = tabsOn && stage?.tab.kind === "designs" && stage.chatKey === chatId ? stage : null;
  const stagedPage = staged?.tab.kind === "designs" ? (staged.tab.page as DockPage) : null;
  const announced = tabsOn && opened && chatId ? `${opened.page}#${opened.focus.nonce}` : null;
  useEffect(() => {
    if (announced && chatId && opened) requestTab(chatId, { kind: "designs", chatId: sessionIdFromKey(chatId), page: opened.page }, !opened.agent);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- asks once per opening, named by its page and nonce
  }, [announced]);
  useEffect(() => {
    if (stagedPage && opened?.page !== stagedPage) open(stagedPage);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- follows the staged page, not each render's callback
  }, [stagedPage, opened?.page]);
  const hidden = tabsOn && !staged;
  const fills = !!staged && !staged.beside;
  return {
    staged: staged ? { beside: staged.beside } : undefined,
    toggleClosesTab: !!staged,
    visible: (shown) => shown && !hidden,
    takesRoom: (shown) => shown && !hidden && !fills,
    close: (closePanel, page) => (staged && chatId ? () => requestClose(chatId, { kind: "designs", chatId: sessionIdFromKey(chatId), page }) : closePanel),
  };
}

type DesignsStage = {
  staged: { beside: boolean } | undefined;
  toggleClosesTab: boolean;
  visible: (chatShown: boolean) => boolean;
  takesRoom: (chatShown: boolean) => boolean;
  close: (closePanel: () => void, page: DockPage) => () => void;
};
