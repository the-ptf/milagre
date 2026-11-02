import { createContext, useContext } from "react";

/** A Chat's simulators, as the Mac names it. */
export type SimulatorTab = { hostId: string; chatId: string };
/** The Chat's Browser, optionally opening a link on its computer. */
export type BrowserTab = { hostId: string; chatId: string; url?: string; requestId?: number };
/** The design a card opened (the Chat's designs canvas), or the Chat's HTML artifact. */
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
/** What a Chat opens in the right panel instead of full screen. */
export type ChatTab = { kind: "simulator"; target: SimulatorTab } | { kind: "designs"; target: DesignsTab } | { kind: "browser"; target: BrowserTab };

/**
 * Opens a tab of the Chat's own in the right panel docked beside it (an iPad). Null where those open full screen: a
 * phone, a narrow window, or the Chat open beside the routed one, which leaves the panels to it.
 */
export const PanelTabsContext = createContext<((tab: ChatTab) => void) | null>(null);

export function usePanelTabs() {
  return useContext(PanelTabsContext);
}
