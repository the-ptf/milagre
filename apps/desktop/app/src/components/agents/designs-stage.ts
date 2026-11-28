import { useEffect, useSyncExternalStore } from "react";
import { sessionIdFromKey } from "../../lib/agent-runs";
import { requestClose, requestTab, useStage, useWorkspaceTabsOn } from "../../lib/workspace-stage";
import type { DockPage } from "./dock-feedback";

const announcedIn = new Map<string, string>();

/**
 * With Workspace tabs, a Chat's designs show while their tab is in front: opening them (a card, the agent starting a
 * design) asks for the tab, unread when the agent did it, and the tab coming forward opens its page; the panel shows only
 * while its tab is in front. A Chat's transcript waits in a hidden <Activity> while another Chat shows, and its effects run
 * again when it comes back: an opening is announced once, so coming back keeps the tab the user left in front.
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
  const opening = opened && chatId ? `${opened.page}#${opened.focus.nonce}` : null;
  const announced = tabsOn ? opening : null;
  useEffect(() => {
    if (chatId && !opening) announcedIn.delete(chatId);
  }, [chatId, opening]);
  useEffect(() => {
    if (!announced || !chatId || !opened || announcedIn.get(chatId) === announced) return;
    announcedIn.set(chatId, announced);
    requestTab(chatId, { kind: "designs", chatId: sessionIdFromKey(chatId), page: opened.page }, !opened.agent);
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

/** What a Chat's designs offer as a Workspace tab: Paradise with its design count, and the Artifact page's title. */
export type DesignOffer = { designs: number | null; page: string | null };

const offers = new Map<string, DesignOffer>();
const offerListeners = new Set<() => void>();
const onOffers = (listener: () => void) => {
  offerListeners.add(listener);
  return () => offerListeners.delete(listener);
};
const publishOffer = (chatKey: string, offer: DesignOffer | null) => {
  const before = offers.get(chatKey);
  if (offer ? before?.designs === offer.designs && before.page === offer.page : !before) return;
  if (offer) offers.set(chatKey, offer);
  else offers.delete(chatKey);
  offerListeners.forEach((listener) => listener());
};

/** The shown Chat's designs telling the New tab what it can open; withdrawn when the Chat hides or has none. */
export function useOfferDesigns(chatKey: string | null, designs: number | null, page: string | null) {
  const offered = designs !== null || page !== null;
  useEffect(() => {
    if (!chatKey || !offered) return;
    publishOffer(chatKey, { designs, page });
  }, [chatKey, offered, designs, page]);
  useEffect(() => {
    if (!chatKey || !offered) return;
    return () => publishOffer(chatKey, null);
  }, [chatKey, offered]);
}

export function useDesignOffer(chatKey: string | null): DesignOffer | undefined {
  return useSyncExternalStore(onOffers, () => (chatKey ? offers.get(chatKey) : undefined));
}
