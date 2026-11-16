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
  available: boolean;
  dockable: boolean;
};

type Split = SplitLayout & {
  pinned: boolean;
  hidden: boolean;
  toggle: () => void;
};

const LayoutContext = createContext<SplitLayout | null>(null);
const SplitContext = createContext<Split | null>(null);

export function SplitProvider({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const session = useSession();
  const pathname = usePathname();
  const [hidden, setHidden] = useState(false);
  const kind = widthClass(width);
  const available = !!session.client && pathname !== "/" && pathname !== "/pair";
  const dockable = kind === "wide" && available;
  const docked = useRightDocked();
  const panelWidth = clampPanelWidth(width, usePanelWidth());
  const crowded = !sidebarFits(width, docked, panelWidth);
  const pinned = dockable && ((!hidden && !crowded) || pathname === "/projects");
  const { closeRight } = usePanelScreen();
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

export function useCardTop() {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const screen = Dimensions.get("screen");
  const { top, controls } = cardTop(insets.top, window.width < screen.width || window.height < screen.height);
  // The safe area a card's content lays out with: none, but for the window controls over its corner.
  const content = useMemo(() => ({ top: controls, right: 0, bottom: 0, left: 0 }), [controls]);
  return { top, controls, content };
}
