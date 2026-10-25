import React, { useCallback, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { router, type Href } from "expo-router";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { ProjectNavigation } from "./project-navigation";
import { NO_INSETS, usePanelScreen } from "./side-panels";
import { useSplit } from "./split-context";
import { CARD_MARGIN, CARD_TOP, SIDEBAR_WIDTH } from "./split-width";
import { chatShortcutIndex, useHardwareShortcuts, type ShortcutId } from "./hardware-keys";
import { requestNavigation } from "./navigation-commands";
import { useTheme } from "./theme";

/**
 * The app's frame: on a wide iPad the Chats list is a card pinned beside the screen, as desktop's sidebar sits beside
 * its Chat. Narrower, the screen has the whole window and the list slides over it (side-panels.tsx).
 */
export function SplitShell({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { pinned, dockable } = useSplit();
  const { open, show } = usePanelScreen();
  // Turned to landscape with the sidebar sliding over, it gives way to the pinned one.
  useEffect(() => {
    if (dockable && open === "left") show(null);
  }, [dockable, open, show]);
  // The screen keeps its place in the tree as the sidebar comes and goes, so the navigator is never remounted.
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.page }}>
      {pinned && <PinnedSidebar />}
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

function PinnedSidebar() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { chatId } = usePanelScreen();
  // A Chat replaces the screen beside the sidebar, closing any sheet first; secondary pages and sheets open over it.
  const navigate = useCallback((href: Href, secondary: boolean | "sheet" = false) => {
    if (secondary) {
      router.push(href);
      return;
    }
    if (router.canDismiss()) router.dismissAll();
    router.replace(href);
  }, []);
  return (
    <View
      style={[
        s.card,
        {
          marginTop: insets.top + CARD_TOP,
          marginBottom: Math.max(insets.bottom, CARD_MARGIN),
          backgroundColor: colors.surface,
          borderColor: colors.line,
        },
      ]}
    >
      {/* The card sits below the status bar already, so the list inside lays out with no safe area of its own. */}
      <SafeAreaInsetsContext.Provider value={NO_INSETS}>
        <ProjectNavigation docked activeChatId={chatId} onNavigate={navigate} />
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

/** Desktop's shortcuts on an iPad's keyboard; renders nothing. Mount it once, inside the split and panel providers. */
export function HardwareShortcuts() {
  const split = useSplit();
  const panels = usePanelScreen();
  const onShortcut = useCallback(
    (id: ShortcutId) => {
      if (id === "settings") {
        router.push("/settings");
        return;
      }
      if (id === "changes") {
        if (panels.worktreeId !== undefined) panels.show(panels.open === "right" ? null : "right");
        return;
      }
      if (id === "sidebar") {
        if (split.dockable) split.toggle();
        else if (panels.attached) panels.show(panels.open === "left" ? null : "left");
        return;
      }
      // New Chat, search and ⌘1 to ⌘9 go to the Chats list on screen, showing it first where it is hidden or slides over.
      const index = chatShortcutIndex(id);
      requestNavigation(id === "new-chat" ? { kind: "new" } : id === "search" ? { kind: "search" } : { kind: "chat", index: index ?? 0 });
      if (split.dockable) {
        if (split.hidden) split.toggle();
      } else if (panels.attached && panels.open !== "left") panels.show("left");
    },
    [split, panels],
  );
  useHardwareShortcuts(onShortcut);
  return null;
}

const s = StyleSheet.create({
  card: {
    width: SIDEBAR_WIDTH,
    marginLeft: CARD_MARGIN,
    borderRadius: 18,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});
