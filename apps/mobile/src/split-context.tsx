import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Dimensions, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname } from "expo-router";
import { useSession } from "./session";
import { cardTop, clampPanelWidth, sidebarFits, widthClass, type WidthClass } from "./split-width";
import { usePanelWidth } from "./panel-width";
import { usePanelScreen, useRightDocked } from "./side-panels";

type SplitLayout = {
  widthClass: WidthClass;
  /** A computer is open, so there is a Chats list to show: not over the Computers list or pairing. */
  available: boolean;
  /** The window is wide enough for the sidebar to stay beside the Chat, whether or not it is hidden now. */
  dockable: boolean;
};

type Split = SplitLayout & {
  /** The sidebar is pinned beside the Chat right now. */
  pinned: boolean;
  hidden: boolean;
  toggle: () => void;
};

// Two contexts: showing or hiding the sidebar re-renders only what reads `pinned`, not the Chat and Chats list that read the
// width class, so the slide has no heavy render to wait on.
const LayoutContext = createContext<SplitLayout | null>(null);
const SplitContext = createContext<Split | null>(null);

/** Decides, from the window's width, whether the Chats list is pinned beside the Chat, slides over it or is a page. */
export function SplitProvider({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const session = useSession();
  const pathname = usePathname();
  const [hidden, setHidden] = useState(false);
  const kind = widthClass(width);
  const available = !!session.client && pathname !== "/" && pathname !== "/pair";
  const dockable = kind === "wide" && available;
  // With the right panel docked too, the sidebar gives way when the Chat between them would get too narrow, and comes
  // back when the panel closes.
  const docked = useRightDocked();
  const panelWidth = clampPanelWidth(width, usePanelWidth());
  const crowded = !sidebarFits(width, docked, panelWidth);
  // The Chats page itself keeps the sidebar: hidden there, the page would be empty.
  const pinned = dockable && ((!hidden && !crowded) || pathname === "/projects");
  const { closeRight } = usePanelScreen();
  // Showing the sidebar where the docked panel left it no room closes the panel, as desktop makes room for the newest.
  const toggle = useCallback(() => {
    if (crowded) {
      closeRight();
      setHidden(false);
    } else setHidden((current) => !current);
  }, [crowded, closeRight]);
  const layout = useMemo(() => ({ widthClass: kind, available, dockable }), [kind, available, dockable]);
  const value = useMemo(() => ({ ...layout, pinned, hidden, toggle }), [layout, pinned, hidden, toggle]);
  return (
    <LayoutContext.Provider value={layout}>
      <SplitContext.Provider value={value}>{children}</SplitContext.Provider>
    </LayoutContext.Provider>
  );
}

/** The window's width class and whether the sidebar can pin, without re-rendering when it shows or hides. */
export function useSplitLayout() {
  const layout = useContext(LayoutContext);
  if (!layout) throw new Error("The split layout needs SplitProvider.");
  return layout;
}

export function useSplit() {
  const split = useContext(SplitContext);
  if (!split) throw new Error("The split layout needs SplitProvider.");
  return split;
}

/**
 * Where a sidebar or Changes card starts, and how far its content keeps below the window controls. A window smaller
 * than the screen is a resizable one (Stage Manager, iPadOS windowing), which has those controls in its corner.
 */
export function useCardTop() {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  // Read on every window change, which a rotation also is.
  const screen = Dimensions.get("screen");
  const { top, controls } = cardTop(insets.top, window.width < screen.width || window.height < screen.height);
  // The safe area a card's content lays out with: none, but for the window controls over its corner.
  const content = useMemo(() => ({ top: controls, right: 0, bottom: 0, left: 0 }), [controls]);
  return { top, controls, content };
}
