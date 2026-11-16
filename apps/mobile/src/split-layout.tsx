import { toggleDictationShortcut } from "./dictation-shortcut";
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
import { duration, easing, radius } from "./design-tokens";
import { useTheme } from "./theme";
import * as Haptics from "expo-haptics";
import { ArrowHorizontalIcon } from "@hugeicons/core-free-icons";
import { Icon } from "./icons";

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
  const [kept, setKept] = useState(false);
  if (pinned && !kept) setKept(true);
  if (!available && kept) setKept(false);
  useEffect(() => {
    if (dockable && open === "left") show(null);
  }, [dockable, open, show]);
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.page }}>
      {(pinned || kept) && <PinnedSidebar shown={pinned} />}
      <View style={{ flex: 1 }}>{children}</View>
      <RightDock />
    </View>
  );
}

const SLOT = SIDEBAR_WIDTH + CARD_MARGIN;
/** iOS's own sidebar timing: quick off the mark, settling gently. */
const SLIDE = { duration: duration.slow, easing: Easing.bezier(...easing.slide), reduceMotion: ReduceMotion.System };

function PinnedSidebar({ shown }: { shown: boolean }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const top = useCardTop();
  const scale = useMotionScale();
  const progress = useSharedValue(shown ? 1 : 0);
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
        <SafeAreaInsetsContext.Provider value={top.content}>{list}</SafeAreaInsetsContext.Provider>
      </Animated.View>
    </Animated.View>
  );
}

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
  // Keep both content trees at their committed width during a drag. Reflowing the transcript, native blur and panel
  // on every touch frame stalls the iPad; only the divider follows the finger, then the layout changes once on release.
  const target = clampPanelWidth(window.width, usePanelWidth());
  const max = clampPanelWidth(window.width, Infinity);
  const width = useSharedValue(target);
  const start = useSharedValue(target);
  const preview = useSharedValue(target);
  const dragging = useSharedValue(false);
  useEffect(() => {
    width.set(target);
    preview.set(target);
    dragging.set(false);
  }, [target, width, preview, dragging]);
  const detents = useMemo(() => [CHANGES_WIDTH, Math.round(window.width / 2)].filter((at) => at > PANEL_MIN_WIDTH && at < max), [window.width, max]);
  const resize = useMemo(() => resizeGesture(width, preview, start, dragging, max, detents), [width, preview, start, dragging, max, detents]);
  const slot = useAnimatedStyle(() => ({ width: progress.get() * (DOCK_GUTTER + width.get() + CARD_MARGIN) }));
  const sized = useAnimatedStyle(() => ({ width: width.get() }));
  const divider = useAnimatedStyle(() => ({ transform: [{ translateX: dragging.get() ? start.get() - preview.get() : 0 }] }));
  const standIn = useAnimatedStyle(() => ({ width: preview.get(), opacity: withTiming(dragging.get() ? 1 : 0, { duration: dragging.get() ? 100 : 200 }) }));
  const real = useAnimatedStyle(() => ({ opacity: withTiming(dragging.get() ? 0 : 1, { duration: dragging.get() ? 100 : 200 }) }));
  const grip = useAnimatedStyle(() => ({ transform: [{ scaleY: withTiming(dragging.get() ? 1.6 : 1, { duration: duration.base }) }] }));
  const held = useAnimatedStyle(() => ({ opacity: withTiming(dragging.get() ? 1 : 0, { duration: duration.base }) }));
  if (!mounted || !kept) return null;
  const step = (by: number) => setPanelWidth(clampPanelWidth(window.width, target + by));
  return (
    <Animated.View
      pointerEvents={shown ? "auto" : "none"}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      style={[s.dockSlot, slot]}
    >
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
          real,
        ]}
      >
        {/* The card sits clear of the status bar already: what it holds lays out with no safe area of its own. */}
        <SafeAreaInsetsContext.Provider value={NO_INSETS}>
          <RightPanel screen={kept} card visible={shown} />
        </SafeAreaInsetsContext.Provider>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[
          s.standIn,
          {
            top: top.top,
            bottom: Math.max(insets.bottom, CARD_MARGIN),
            backgroundColor: colors.surface,
            borderColor: "transparent",
            boxShadow: colors.shadowRaised,
          },
          standIn,
        ]}
      >
        <View style={[s.standInBadge, { backgroundColor: colors.page }]}>
          <Icon icon={ArrowHorizontalIcon} tone="ink3" size={20} />
        </View>
      </Animated.View>
      <GestureDetector gesture={resize}>
        <Animated.View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Panel width"
          accessibilityHint="Drag sideways to resize the panel. Double tap puts it back."
          accessibilityValue={{ min: PANEL_MIN_WIDTH, max, now: target }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={({ nativeEvent }) => step(nativeEvent.actionName === "increment" ? 40 : -40)}
          hitSlop={{ left: 0, right: 12, top: 0, bottom: 0 }}
          style={[s.grabber, { top: top.top, bottom: Math.max(insets.bottom, CARD_MARGIN) }, divider]}
        >
          <Animated.View style={[s.grip, { backgroundColor: colors.lineStrong }, grip]}>
            <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: radius.full, backgroundColor: colors.ink2 }, held]} />
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

function resizeGesture(
  width: SharedValue<number>,
  preview: SharedValue<number>,
  start: SharedValue<number>,
  dragging: SharedValue<boolean>,
  max: number,
  detents: number[],
) {
  const drag = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .onStart(() => {
      start.set(width.get());
      preview.set(width.get());
      dragging.set(true);
      scheduleOnRN(pickUp);
    })
    .onUpdate((event) => {
      const raw = Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, start.get() - event.translationX)));
      const near = detents.find((at) => Math.abs(at - raw) <= SNAP);
      const next = near ?? raw;
      const holds = (at: number) => at === PANEL_MIN_WIDTH || at === max || detents.includes(at);
      if (next !== preview.get() && holds(next)) scheduleOnRN(tick);
      preview.set(next);
    })
    .onEnd(() => {
      width.set(preview.get());
      scheduleOnRN(setPanelWidth, preview.get());
    })
    .onFinalize(() => {
      dragging.set(false);
      preview.set(width.get());
    });
  const reset = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scheduleOnRN(pickUp);
      scheduleOnRN(setPanelWidth, CHANGES_WIDTH);
    });
  return Gesture.Race(drag, reset);
}

const SNAP = 16;
function tick() {
  void Haptics.selectionAsync();
}
function pickUp() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** The connected Mac's keybindings on an iPad's keyboard; renders nothing. Mount it once, inside the split and panel providers. */
export function HardwareShortcuts() {
  const split = useSplit();
  const panels = usePanelScreen();
  const keybindings = useHostKeybindings(useSession().client);
  const onShortcut = useCallback(
    (command: KeybindingCommandId) => {
      if (command === "dictation.toggle") {
        toggleDictationShortcut();
        return;
      }
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

const CARD_CORNERS = { borderRadius: radius.sheet, borderCurve: "continuous" } as const;

const s = StyleSheet.create({
  slot: { overflow: "hidden" },
  dockSlot: { zIndex: 1 },
  grabber: { position: "absolute", left: 0, width: DOCK_GUTTER, alignItems: "center", justifyContent: "center" },
  standIn: {
    position: "absolute",
    right: CARD_MARGIN,
    ...CARD_CORNERS,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  standInBadge: { width: 56, height: 56, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  grip: { width: 4, height: 44, borderRadius: radius.full },
  card: {
    flex: 1,
    width: SIDEBAR_WIDTH,
    marginLeft: CARD_MARGIN,
    ...CARD_CORNERS,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});
