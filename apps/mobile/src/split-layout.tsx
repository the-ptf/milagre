import React, { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { ProjectNavigation } from "./project-navigation";
import { RightPanel, usePanelScreen, useRightPanelScreen } from "./side-panels";
import { useCardTop, useSplit } from "./split-context";
import { CARD_MARGIN, CHANGES_WIDTH, DOCK_GUTTER, PANEL_MIN_WIDTH, SIDEBAR_WIDTH, clampPanelWidth } from "./split-width";
import { setPanelWidth, usePanelWidth } from "./panel-width";
import type { KeybindingCommandId } from "@milagre/shared/keybindings";
import { chatShortcutIndex, useHardwareShortcuts } from "./hardware-keys";
import { rulesOf, useHostKeybindings } from "./keybindings-store";
import { isOpenChat, requestNavigation } from "./navigation-commands";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { scaledTiming, useMotionScale } from "./motion";

/**
 * The app's frame: on a wide iPad the Chats list is a card pinned beside the screen, as desktop's sidebar sits beside
 * its Chat. Narrower, the screen has the whole window and the list slides over it (side-panels.tsx). On an iPad the right
 * panel (Changes, a PR, a simulator, designs) docks on the other side, pushing the screen over as desktop's panels do.
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
      <RightDock />
    </View>
  );
}

/** The room the pinned sidebar takes beside the Chat: its card and the gap to its left. */
const SLOT = SIDEBAR_WIDTH + CARD_MARGIN;
/** iOS's own sidebar timing: quick off the mark, settling gently. */
const SLIDE = { duration: 320, easing: Easing.bezier(0.32, 0.72, 0, 1), reduceMotion: ReduceMotion.System };

function PinnedSidebar({ shown }: { shown: boolean }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const top = useCardTop();
  const scale = useMotionScale();
  // Hiding, the slot narrows as the card slides out past the left edge, and the Chat widens into the room it leaves.
  const progress = useSharedValue(shown ? 1 : 0);
  // The list wakes (reloads its Projects, reads every computer) once it has slid in, and sleeps once it has slid out:
  // the renders that follow would otherwise land on the slide's frames and stutter it.
  const [awake, setAwake] = useState(shown);
  useEffect(() => {
    progress.set(
      withTiming(shown ? 1 : 0, scaledTiming(SLIDE, scale), (finished) => {
        if (finished) scheduleOnRN(setAwake, shown);
      }),
    );
  }, [shown, progress, scale]);
  const slot = useAnimatedStyle(() => ({ width: progress.get() * SLOT }));
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: (progress.get() - 1) * SLOT }] }));
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
  // Made once per change of what it shows, so showing or hiding the sidebar doesn't render the list again on the slide's
  // first frame.
  const activeChatId = pathname === "/chat" ? chatId : undefined;
  const list = useMemo(() => <ProjectNavigation docked visible={awake} activeChatId={activeChatId} onNavigate={navigate} />, [awake, activeChatId, navigate]);
  return (
    <Animated.View
      pointerEvents={shown ? "auto" : "none"}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      style={[s.slot, slot]}
    >
      <Animated.View
        style={[
          s.card,
          {
            marginTop: top.top,
            marginBottom: Math.max(insets.bottom, CARD_MARGIN),
            backgroundColor: colors.surface,
            borderColor: colors.line,
          },
          slide,
        ]}
      >
        {/* The card sits clear of the status bar already, so the list inside keeps only below a window's controls. */}
        <SafeAreaInsetsContext.Provider value={top.content}>{list}</SafeAreaInsetsContext.Provider>
      </Animated.View>
    </Animated.View>
  );
}

/**
 * The right panel docked beside the screen. It slides in from the right edge as its slot widens and the screen narrows
 * into the room it leaves, and out the same way; it stays mounted, showing what it showed, until it is all the way out.
 * The grabber in the gutter on its left resizes it, as iPadOS's split view divider does; a double tap puts it back.
 */
function RightDock() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const top = useCardTop();
  const scale = useMotionScale();
  const { screen, shown } = useRightPanelScreen();
  const [kept, setKept] = useState(screen);
  if (shown && screen && kept !== screen) setKept(screen);
  const [mounted, setMounted] = useState(shown);
  if (shown && !mounted) setMounted(true);
  const progress = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    progress.set(
      withTiming(shown ? 1 : 0, scaledTiming(SLIDE, scale), (finished) => {
        if (finished && !shown) scheduleOnRN(setMounted, false);
      }),
    );
  }, [shown, progress, scale]);
  // The width it was dragged to, within the room this window has; a drag moves it frame by frame and saves it at the end.
  const target = clampPanelWidth(window.width, usePanelWidth());
  const max = clampPanelWidth(window.width, Infinity);
  const width = useSharedValue(target);
  const start = useSharedValue(target);
  // A reset or a turn of the window eases to the new width; a drag already holds it there, so that ease has nothing to do.
  useEffect(() => {
    width.set(withTiming(target, scaledTiming(SLIDE, scale)));
  }, [target, width, scale]);
  const resize = useMemo(() => resizeGesture(width, start, max), [width, start, max]);
  const slot = useAnimatedStyle(() => ({ width: progress.get() * (DOCK_GUTTER + width.get() + CARD_MARGIN) }));
  const sized = useAnimatedStyle(() => ({ width: width.get() }));
  if (!mounted || !kept) return null;
  const step = (by: number) => setPanelWidth(clampPanelWidth(window.width, target + by));
  return (
    <Animated.View
      pointerEvents={shown ? "auto" : "none"}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      style={[s.slot, slot]}
    >
      {/* Held at the slot's left edge, the card rides it in from the window's edge while the slot widens. */}
      <Animated.View
        style={[
          s.card,
          {
            marginLeft: DOCK_GUTTER,
            marginTop: top.top,
            marginBottom: Math.max(insets.bottom, CARD_MARGIN),
            backgroundColor: colors.surface,
            borderColor: colors.line,
          },
          sized,
        ]}
      >
        {/* The card sits clear of the status bar already: what it holds lays out with no safe area of its own. */}
        <SafeAreaInsetsContext.Provider value={NO_INSETS}>
          <RightPanel screen={kept} card visible={shown} />
        </SafeAreaInsetsContext.Provider>
      </Animated.View>
      <GestureDetector gesture={resize}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Panel width"
          accessibilityHint="Drag sideways to resize the panel. Double tap puts it back."
          accessibilityValue={{ min: PANEL_MIN_WIDTH, max, now: target }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={({ nativeEvent }) => step(nativeEvent.actionName === "increment" ? 40 : -40)}
          hitSlop={{ left: 0, right: 12, top: 0, bottom: 0 }}
          style={[s.grabber, { top: top.top, bottom: Math.max(insets.bottom, CARD_MARGIN) }]}
        >
          <View style={[s.grip, { backgroundColor: colors.lineStrong }]} />
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

/** A drag on the panel's grabber: left makes it wider, right narrower, saved once the finger lifts; a double tap resets it. */
function resizeGesture(width: SharedValue<number>, start: SharedValue<number>, max: number) {
  const drag = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .onStart(() => {
      start.set(width.get());
    })
    .onUpdate((event) => {
      width.set(Math.min(max, Math.max(PANEL_MIN_WIDTH, start.get() - event.translationX)));
    })
    .onEnd(() => {
      scheduleOnRN(setPanelWidth, Math.round(width.get()));
    });
  const reset = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scheduleOnRN(setPanelWidth, CHANGES_WIDTH);
    });
  return Gesture.Race(drag, reset);
}

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** The connected Mac's keybindings on an iPad's keyboard; renders nothing. Mount it once, inside the split and panel providers. */
export function HardwareShortcuts() {
  const split = useSplit();
  const panels = usePanelScreen();
  const keybindings = useHostKeybindings(useSession().client);
  const onShortcut = useCallback(
    (command: KeybindingCommandId) => {
      if (command === "settings.open") {
        router.push("/settings");
        return;
      }
      if (command === "changes.toggle") {
        if (panels.right) panels.closeRight();
        else if (panels.worktreeId !== undefined) panels.show("right");
        return;
      }
      if (command === "sidebar.toggle") {
        if (split.dockable) split.toggle();
        else if (panels.attached) panels.show(panels.open === "left" ? null : "left");
        return;
      }
      // New Chat, search and the Chat jumps go to the Chats list on screen, showing it first where it is hidden or slides over.
      const index = chatShortcutIndex(command);
      if (command !== "chat.new" && command !== "commandPalette.toggle" && index === null) return;
      requestNavigation(
        command === "chat.new" ? { kind: "new" } : command === "commandPalette.toggle" ? { kind: "search" } : { kind: "chat", index: index ?? 0 },
      );
      if (split.dockable) {
        if (!split.pinned) split.toggle();
      } else if (panels.attached && panels.open !== "left") panels.show("left");
    },
    [split, panels],
  );
  useHardwareShortcuts(rulesOf(keybindings), onShortcut);
  return null;
}

const s = StyleSheet.create({
  slot: { overflow: "hidden" },
  grabber: { position: "absolute", left: 0, width: DOCK_GUTTER, alignItems: "center", justifyContent: "center" },
  grip: { width: 4, height: 44, borderRadius: 2 },
  card: {
    flex: 1,
    width: SIDEBAR_WIDTH,
    marginLeft: CARD_MARGIN,
    borderRadius: 18,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});
