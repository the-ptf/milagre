import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Dimensions, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname } from "expo-router";
import { useSession } from "./session";
import { cardTop, widthClass, type WidthClass } from "./split-width";

type Split = {
  widthClass: WidthClass;
  /** A computer is open, so there is a Chats list to show: not over the Computers list or pairing. */
  available: boolean;
  /** The window is wide enough for the sidebar to stay beside the Chat, whether or not it is hidden now. */
  dockable: boolean;
  /** The sidebar is pinned beside the Chat right now. */
  pinned: boolean;
  hidden: boolean;
  toggle: () => void;
};

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
  // The Chats page itself keeps the sidebar: hidden there, the page would be empty.
  const pinned = dockable && (!hidden || pathname === "/projects");
  const toggle = useCallback(() => setHidden((current) => !current), []);
  const value = useMemo(() => ({ widthClass: kind, available, dockable, pinned, hidden, toggle }), [kind, available, dockable, pinned, hidden, toggle]);
  return <SplitContext.Provider value={value}>{children}</SplitContext.Provider>;
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
