import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { ProjectNavigation } from "./project-navigation";
import { NO_INSETS, usePanelScreen } from "./side-panels";
import { useSplit } from "./split-context";
import { CARD_MARGIN, CARD_TOP, SIDEBAR_WIDTH } from "./split-width";
import { chatShortcutIndex, useHardwareShortcuts, type ShortcutId } from "./hardware-keys";
import { isOpenChat, requestNavigation } from "./navigation-commands";
import { useSession } from "./session";
import { useTheme } from "./theme";

/**
 * The app's frame: on a wide iPad the Chats list is a card pinned beside the screen, as desktop's sidebar sits beside
 * its Chat. Narrower, the screen has the whole window and the list slides over it (side-panels.tsx).
 */
export function SplitShell({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { pinned, dockable, available } = useSplit();
  const { open, show } = usePanelScreen();
  // Once pinned, the sidebar stays mounted (hidden when the window narrows) while a computer is open: a Chat it is
  // opening on another computer still arrives when the window drops below the pinned width mid-switch.
  const [kept, setKept] = useState(false);
  if (pinned && !kept) setKept(true);
  if (!available && kept) setKept(false);
  // Turned to landscape with the sidebar sliding over, it gives way to the pinned one.
  useEffect(() => {
    if (dockable && open === "left") show(null);
  }, [dockable, open, show]);
  // The screen keeps its place in the tree as the sidebar comes and goes, so the navigator is never remounted.
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.page }}>
      {(pinned || kept) && <PinnedSidebar shown={pinned} />}
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

function PinnedSidebar({ shown }: { shown: boolean }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const pathname = usePathname();
  const { chatId } = usePanelScreen();
  const hostId = session.client?.url;
  const projectPath = session.snapshot?.project.path;
  // A Chat replaces the screen beside the sidebar, closing any sheet first; secondary pages and sheets open over it.
  // The open Chat, picked from a page pushed over it (Canvas, Routines), is reached by closing the page alone.
  const navigate = useCallback(
    (href: Href, secondary: boolean | "sheet" = false) => {
      if (secondary) {
        router.push(href);
        return;
      }
      if (router.canDismiss()) router.dismissAll();
      if (!isOpenChat(href, { hostId, projectPath, chatId })) router.replace(href);
    },
    [hostId, projectPath, chatId],
  );
  return (
    <View
      style={[
        s.card,
        {
          display: shown ? "flex" : "none",
          marginTop: insets.top + CARD_TOP,
          marginBottom: Math.max(insets.bottom, CARD_MARGIN),
          backgroundColor: colors.surface,
          borderColor: colors.line,
        },
      ]}
    >
      {/* The card sits below the status bar already, so the list inside lays out with no safe area of its own. */}
      <SafeAreaInsetsContext.Provider value={NO_INSETS}>
        <ProjectNavigation docked visible={shown} activeChatId={pathname === "/chat" ? chatId : undefined} onNavigate={navigate} />
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
