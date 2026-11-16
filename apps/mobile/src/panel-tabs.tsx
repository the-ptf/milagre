import { createContext, useContext } from "react";

export type SimulatorTab = { hostId: string; chatId: string };
export type BrowserTab = { hostId: string; chatId: string; url?: string; requestId?: number };
export type DesignsTab = {
  hostId: string;
  chatId: string;
  id: string;
  version?: string;
  chosen?: string;
  html?: boolean;
  tab?: string;
  comment?: string;
  requestId?: string;
};
export type ChatTab = { kind: "simulator"; target: SimulatorTab } | { kind: "designs"; target: DesignsTab } | { kind: "browser"; target: BrowserTab };

/**
 * Opens a tab of the Chat's own in the right panel docked beside it (an iPad). Null where those open full screen: a
 * phone, a narrow window, or the Chat open beside the routed one, which leaves the panels to it.
 */
export const PanelTabsContext = createContext<((tab: ChatTab) => void) | null>(null);

export function usePanelTabs() {
  return useContext(PanelTabsContext);
}
