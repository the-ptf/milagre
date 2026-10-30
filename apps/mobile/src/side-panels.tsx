import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { afterPaint } from "@milagre/shared/after-paint";
import { BackHandler, Keyboard, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { router, useFocusEffect, useNavigation, type Href } from "expo-router";
import { SafeAreaInsetsContext, useSafeAreaInsets, type EdgeInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ArrowLeft01Icon, BrowserIcon, Cancel01Icon, File01Icon, FileDiffIcon, PaintBoardIcon, SmartphoneIcon } from "@hugeicons/core-free-icons";
import { useSession } from "./session";
import { ProjectNavigation } from "./project-navigation";
import { ClosesLeftContext, hideRevealed } from "./chat-swipe-row";
import { ChangesView } from "./app/changes";
import { ChangesShownContext } from "./change-tree";
import { DiffView, type DiffTarget } from "./app/diff";
import { GlassIconButton, IconButton, tap } from "./ui";
import { Icon, type IconData, type Tone } from "./icons";
import { PrOverview } from "./pr-overview";
import { openPrFile, openPrPage } from "./pr-nav";
import { prChoiceKey, type PrChoice } from "./pr-chat";
import { springTo, scaledTiming, useMotionScale } from "./motion";
import { getMotionScale, useTheme } from "./theme";
import { dragTo, entered, settle } from "./panel-motion";
import { useCardTop, useSplitLayout } from "./split-context";
import { CARD_MARGIN, CHANGES_WIDTH, SIDEBAR_WIDTH, rightDocks, widthClass } from "./split-width";
import { SimulatorSheet } from "./simulator";
import { DesignsSheet } from "./designs-sheet";
import { ArtifactSheet } from "./artifact";
import { BrowserSheet } from "./browser";
import type { BrowserTab, ChatTab, DesignsTab, SimulatorTab } from "./panel-tabs";
import { PR_ICONS } from "./pr-look";

type Side = "left" | "right";
/** What the focused screen offers: the left panel always, Changes when it has a Worktree, its PR beside Changes when it has one. */
type Screen = { token: object; chatId?: number; worktreeId?: number; pullRequest?: ScreenPullRequest };
/** The Chat's PR the panel opens on, and every PR its row lists for the PR menu. */
type ScreenPullRequest = { number: number; chatKey: string; choices?: PrChoice[]; cwd?: string };
/**
 * What the right panel shows: the Worktree's Changes, the Chat's PR (when it has one), or on an iPad the Chat's
 * simulators, designs or browser, which open there instead of full screen.
 */
type RightTab = "changes" | "pr" | "simulator" | "designs" | "browser";
/** The tabs a Chat opened in the right panel itself. They belong to that Chat: another Chat on screen doesn't show them. */
type ChatTabs = { token: object; chatId?: number; simulator?: SimulatorTab; designs?: DesignsTab; browser?: BrowserTab };
type Panels = {
  screen: Screen | null;
  open: Side | null;
  mounted: Record<Side, boolean>;
  progress: SharedValue<number>;
  from: SharedValue<number>;
  attach: (screen: Screen) => void;
  update: (screen: Screen) => void;
  detach: (token: object) => void;
  arrived: (token: object) => void;
  show: (side: Side | null) => void;
  /** The window is wide enough for the right panel to dock beside the Chat instead of sliding over it. */
  docks: boolean;
  /** The right panel is docked open beside the Chat. */
  docked: boolean;
  /** Closes the right panel, docked or sliding over. */
  closeRight: () => void;
  chatTabs: ChatTabs | null;
  /** Opens a Chat's simulators or designs in the right panel, docked beside the Chat. */
  openTab: (tab: ChatTab) => void;
  closeTab: (kind: ChatTab["kind"]) => void;
  tab: RightTab;
  setTab: (tab: RightTab) => void;
  /** The PR picked in the PR menu (or opened from a link), over the one the Chat's row shows first. */
  pick: string | null;
  setPick: (key: string | null) => void;
  pull: (side: Side) => void;
  settled: (to: number) => void;
  navigate: (href?: Href, secondary?: boolean | "sheet") => void;
};

const SPRING = { damping: 32, stiffness: 320, mass: 0.9, reduceMotion: ReduceMotion.System };
// Points a finger travels sideways before a drag takes over, and up or down before it gives way to scrolling.
const SLOP_X = 16;
const SLOP_Y = 14;
// How long the open navigation waits for the Chat it opened to be on screen before sliding away regardless.
const HANDOFF_MS = 1000;
const PanelsContext = createContext<Panels | null>(null);
const sideOf = (to: number): Side | null => (to > 0 ? "left" : to < 0 ? "right" : null);
/** The native stack's end-of-transition event, which expo-router's navigation types leave out. */
type TransitionEvents = { addListener(event: "transitionEnd", listener: (event: { data: { closing: boolean } }) => void): () => void };

// A Chat opened from the open navigation replaces the screen under it with no animation of its own; the navigation then
// slides off it. The Chat screen's options ask by route: a route rendered during the swap keeps "no animation" until the
// slide ends, since the navigator renders again (the Chat taking the panels) before the native push starts.
let replacingUnderPanel = false;
const enteringUnderPanel = new Set<string>();
export function enterUnderPanel(routeKey: string | undefined) {
  if (routeKey === undefined) return replacingUnderPanel;
  if (replacingUnderPanel) enteringUnderPanel.add(routeKey);
  return enteringUnderPanel.has(routeKey);
}
const forgetEntered = () => enteringUnderPanel.clear();

/**
 * Paseo's panels on a phone: the project navigation on the left of a screen and its Changes on the right, each a
 * full page drawn over everything, header included. The provider sits at the root so a panel can cover the native
 * header; a screen opts in with `useSidePanels` and wraps its content in `PanelSwipe`.
 */
export function SidePanelsProvider({ children }: { children: React.ReactNode }) {
  const { cancelNavigation } = useSession();
  const progress = useSharedValue(0);
  // Where the drag in progress began; one drag runs at a time.
  const from = useSharedValue(0);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [open, setOpen] = useState<Side | null>(null);
  const [tab, setTab] = useState<RightTab>("pr");
  const { width } = useWindowDimensions();
  const docks = rightDocks(width);
  const docking = useRef(docks);
  const [docked, setDocked] = useState(false);
  const dockedNow = useRef(false);
  const [chatTabs, setChatTabs] = useState<ChatTabs | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [mounted, setMounted] = useState<Record<Side, boolean>>({ left: false, right: false });
  const current = useRef<Screen | null>(null);
  const openSide = useRef<Side | null>(null);
  // While a Chat picked in the open navigation replaces the screen under it: the timer that slides the navigation away
  // regardless, and the screen that took the panels, until it paints or its native transition ends.
  const handoff = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelArrival = useRef<(() => void) | null>(null);
  const arriving = useRef<object | null>(null);
  const reset = useCallback(() => {
    progress.set(0);
    setOpen(null);
  }, [progress]);
  const slideAway = useCallback(
    (then?: () => void) => {
      setOpen(null);
      progress.set(
        withTiming(0, scaledTiming({ duration: 180, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }, getMotionScale()), () => {
          if (then) scheduleOnRN(then);
        }),
      );
    },
    [progress],
  );
  const endHandoff = useCallback(() => {
    cancelArrival.current?.();
    cancelArrival.current = null;
    if (handoff.current) clearTimeout(handoff.current);
    handoff.current = null;
    arriving.current = null;
    replacingUnderPanel = false;
  }, []);
  const clear = useCallback(() => {
    reset();
    setScreen(null);
    setMounted({ left: false, right: false });
  }, [reset]);
  // The navigation slides off the Chat it opened once that Chat is drawn: sliding while it still mounts would spend the
  // slide on frames the phone never shows.
  const finishHandoff = useCallback(() => {
    endHandoff();
    if (current.current) slideAway(forgetEntered);
    else {
      forgetEntered();
      clear();
    }
  }, [endHandoff, slideAway, clear]);
  const attach = useCallback(
    (next: Screen) => {
      if (handoff.current && !arriving.current && current.current?.token !== next.token) {
        arriving.current = next.token;
        replacingUnderPanel = false;
        current.current = next;
        setScreen(next);
        setMounted((previous) => (previous.right ? { ...previous, right: false } : previous));
        // The replacement has animation: "none", so transitionEnd can be absent or arrive before its listener.
        // Focus attaches after commit: let that screen paint, then reveal it without waiting for the 1 s watchdog.
        cancelArrival.current = afterPaint(() => {
          if (arriving.current === next.token) finishHandoff();
        });
        return;
      }
      if (current.current?.token !== next.token) reset();
      current.current = next;
      setScreen(next);
    },
    [reset, finishHandoff],
  );
  const arrived = useCallback(
    (token: object) => {
      if (arriving.current === token) finishHandoff();
    },
    [finishHandoff],
  );
  // A focused screen's Chat or Worktree can change under an open panel (a first send, a Project loading); that only
  // swaps what the panels show.
  const update = useCallback((next: Screen) => {
    if (current.current?.token !== next.token) return;
    current.current = next;
    setScreen(next);
  }, []);
  // Blurring keeps the panels: a confirmation or update sheet opens over an open panel and returns to it, and
  // everything the panels navigate to closes them first. A screen the navigation is replacing leaves them up for the
  // Chat that replaces it.
  const detach = useCallback(
    (token: object) => {
      if (current.current?.token !== token) return;
      current.current = null;
      if (!handoff.current) clear();
    },
    [clear],
  );
  const show = useCallback(
    (side: Side | null) => {
      // Wide enough, the right panel docks beside the Chat, which stays in use: the keyboard stays up for it.
      if (side === "right" && docking.current) {
        setMounted((previous) => (previous.right ? previous : { ...previous, right: true }));
        setDocked(true);
        return;
      }
      Keyboard.dismiss();
      if (side) setMounted((previous) => (previous[side] ? previous : { ...previous, [side]: true }));
      setOpen(side);
      progress.set(springTo(side === "left" ? 1 : side === "right" ? -1 : 0, SPRING, getMotionScale()));
    },
    [progress],
  );
  const closeRight = useCallback(() => {
    setDocked(false);
    if (openSide.current === "right") show(null);
  }, [show]);
  const openTab = useCallback(
    (next: ChatTab) => {
      const focused = current.current;
      if (!focused) return;
      setChatTabs((previous) => {
        const own =
          previous && previous.token === focused.token && previous.chatId === focused.chatId ? previous : { token: focused.token, chatId: focused.chatId };
        return { ...own, [next.kind]: next.target };
      });
      setTab(next.kind);
      show("right");
    },
    [show],
  );
  const closeTab = useCallback((kind: ChatTab["kind"]) => {
    setChatTabs((previous) => (previous ? { ...previous, [kind]: undefined } : previous));
  }, []);
  // Turned or resized past the docking width, an open right panel moves between docked and sliding over, as it is.
  useEffect(() => {
    docking.current = docks;
    if (docks && openSide.current === "right") {
      progress.set(0);
      setOpen(null);
      setDocked(true);
    } else if (!docks && dockedNow.current) {
      setDocked(false);
      setMounted((previous) => (previous.right ? previous : { ...previous, right: true }));
      setOpen("right");
      progress.set(-1);
    }
  }, [docks, progress]);
  const pull = useCallback((side: Side) => {
    Keyboard.dismiss();
    // A drag opens the panel on the Chat's PR when it has one, its Changes otherwise.
    if (side === "right") setTab("pr");
    setMounted((previous) => (previous[side] ? previous : { ...previous, [side]: true }));
  }, []);
  // A panel that opens is drawn, whatever the drag pulled on the way; open over nothing, the shade would block every tap.
  const settled = useCallback((to: number) => {
    const side = sideOf(to);
    if (side) setMounted((previous) => (previous[side] ? previous : { ...previous, [side]: true }));
    setOpen(side);
  }, []);
  const go = useCallback((href: Href, secondary: boolean) => {
    if (secondary) {
      router.push(href);
      return;
    }
    if (router.canDismiss()) router.dismissAll();
    router.replace(href);
  }, []);
  // A Chat picked in the open navigation replaces the screen behind it first, and the navigation then slides off the
  // new Chat, so the Chat that was open never shows on the way. Anything else slides the navigation away first, and
  // whatever was still opening is dropped; the navigation goes ahead even when something else stops the slide early
  // (a screen resetting the panels). A sheet opens over the navigation instead, which is still there when it closes.
  const navigate = useCallback(
    (href?: Href, secondary: boolean | "sheet" = false) => {
      if (secondary === "sheet") {
        if (href) router.push(href);
        return;
      }
      Keyboard.dismiss();
      cancelNavigation();
      if (href && !secondary && openSide.current === "left") {
        endHandoff();
        replacingUnderPanel = true;
        // A screen that never shows (the navigation failed) or never reports its transition still gets the navigation off it.
        handoff.current = setTimeout(finishHandoff, HANDOFF_MS);
        go(href, false);
        return;
      }
      slideAway(href ? () => go(href, secondary) : undefined);
    },
    [go, cancelNavigation, endHandoff, finishHandoff, slideAway],
  );
  useEffect(() => {
    openSide.current = open;
  }, [open]);
  useEffect(() => {
    dockedNow.current = docked;
  }, [docked]);
  useEffect(() => endHandoff, [endHandoff]);
  useEffect(() => {
    if (!open) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      show(null);
      return true;
    });
    return () => back.remove();
  }, [open, show]);
  const value = useMemo(
    () => ({
      screen,
      open,
      mounted,
      progress,
      from,
      attach,
      update,
      detach,
      arrived,
      show,
      docks,
      docked,
      closeRight,
      chatTabs,
      openTab,
      closeTab,
      tab,
      setTab,
      pick,
      setPick,
      pull,
      settled,
      navigate,
    }),
    [
      screen,
      open,
      mounted,
      progress,
      from,
      attach,
      update,
      detach,
      arrived,
      show,
      docks,
      docked,
      closeRight,
      chatTabs,
      openTab,
      closeTab,
      tab,
      setTab,
      pick,
      setPick,
      pull,
      settled,
      navigate,
    ],
  );
  return <PanelsContext.Provider value={value}>{children}</PanelsContext.Provider>;
}

function usePanels() {
  const panels = useContext(PanelsContext);
  if (!panels) throw new Error("Side panels need SidePanelsProvider.");
  return panels;
}

export function usePanelNavigation() {
  return usePanels().navigate;
}

/** A sheet such as Ports can return to its Chat and open a tab beside it. Never take another Chat's panel. */
export function useChatPanelTabs(hostId?: string, chatId?: string) {
  const panels = usePanels();
  const session = useSession();
  return panels.docks && hostId === session.client?.url && chatId === `${session.snapshot?.project.path}#${panels.screen?.chatId}` ? panels.openTab : null;
}

/** The focused screen's Chat and Worktree, and the panels it offers, for the pinned sidebar and keyboard shortcuts. */
export function usePanelScreen() {
  const { screen, open, show, docked, closeRight } = usePanels();
  return { attached: !!screen, chatId: screen?.chatId, worktreeId: screen?.worktreeId, open, show, right: open === "right" || docked, closeRight };
}

/** Whether the right panel is docked open beside the Chat now, which the pinned sidebar makes room for. */
export function useRightDocked() {
  const { docks, docked } = usePanels();
  return docks && docked;
}

/** The screen whose right panel docks beside it, and whether it shows now: docked open with something to show. */
export function useRightPanelScreen() {
  const { screen, docks, docked, chatTabs } = usePanels();
  const session = useSession();
  const shown = docks && docked && !!screen && !!session.client && rightTabs(screen, chatTabs).length > 0;
  return { screen, shown };
}

/** The tabs the right panel has for this screen, in the order its tab row shows them. */
function rightTabs(screen: Screen, chatTabs: ChatTabs | null): RightTab[] {
  const own = chatTabs && chatTabs.token === screen.token && chatTabs.chatId === screen.chatId ? chatTabs : null;
  const tabs: RightTab[] = [];
  if (screen.worktreeId !== undefined) tabs.push("changes");
  if (screen.pullRequest) tabs.push("pr");
  if (own?.simulator) tabs.push("simulator");
  if (own?.designs) tabs.push("designs");
  if (own?.browser) tabs.push("browser");
  return tabs;
}

/** How far a panel travels: the whole screen on a phone, a card's width plus its margins on a wider window. */
function panelTravel(width: number) {
  return widthClass(width) === "compact" ? width : SIDEBAR_WIDTH + CARD_MARGIN * 2;
}
/** A card's own safe area: it sits clear of the status bar and home indicator already. */
const NO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Offers the panels while this screen is focused. A rightward drag opens the left one, a leftward drag Changes.
 * `passive` (the Chat open beside the routed one on a wide iPad) offers nothing and leaves the panels to the screen.
 */
export function useSidePanels({
  chatId,
  worktreeId,
  pullRequest,
  passive = false,
}: {
  chatId?: number;
  worktreeId?: number;
  pullRequest?: ScreenPullRequest;
  passive?: boolean;
}) {
  const panels = usePanels();
  const [token] = useState(() => ({}));
  const { attach, update, detach, arrived, show, pull, settled, progress, from, setTab, setPick } = panels;
  const navigation = useNavigation() as unknown as TransitionEvents;
  const prNumber = pullRequest?.number;
  const prChat = pullRequest?.chatKey;
  const prChoices = pullRequest?.choices;
  const prCwd = pullRequest?.cwd;
  // Focus gives the panels to this screen; what it offers is updated in place.
  const offer = useRef<Screen>({ token, chatId, worktreeId, pullRequest });
  useEffect(() => {
    if (passive) return;
    offer.current = {
      token,
      chatId,
      worktreeId,
      ...(prNumber && prChat
        ? { pullRequest: { number: prNumber, chatKey: prChat, ...(prChoices ? { choices: prChoices } : {}), ...(prCwd ? { cwd: prCwd } : {}) } }
        : {}),
    };
    update(offer.current);
  }, [passive, update, token, chatId, worktreeId, prNumber, prChat, prChoices, prCwd]);
  useFocusEffect(
    useCallback(() => {
      if (!passive) attach(offer.current);
    }, [passive, attach]),
  );
  useEffect(() => () => detach(token), [detach, token]);
  // Drawn and in place: the navigation that opened this screen can slide off it now.
  useEffect(
    () => (passive ? undefined : navigation.addListener("transitionEnd", (event) => !event.data.closing && arrived(token))),
    [passive, navigation, arrived, token],
  );
  const { width } = useWindowDimensions();
  const travel = panelTravel(width);
  // Where the sidebar is pinned beside the Chat, a drag only reaches Changes.
  const { dockable } = useSplitLayout();
  const ours = panels.screen?.token === token;
  const scale = useMotionScale();
  const gesture = useMemo(
    () =>
      swipe({
        progress,
        from,
        width: travel,
        // A docked right panel opens from its buttons: a drag can't push the Chat over.
        min: worktreeId === undefined || panels.docks ? 0 : -1,
        max: dockable ? 0 : 1,
        offset: [-SLOP_X, SLOP_X],
        pull,
        settled,
        scale,
      }).enabled(!passive && ours && !panels.open),
    [progress, from, travel, worktreeId, dockable, panels.docks, pull, settled, ours, passive, panels.open, scale],
  );
  // The right panel opened on a PR (its pill on an iPad, a row's PR link) or on Changes (View changes).
  const showPullRequest = useCallback(
    (key?: string) => {
      setTab("pr");
      setPick(key ?? null);
      show("right");
    },
    [setTab, setPick, show],
  );
  const showChanges = useCallback(() => {
    setTab("changes");
    show("right");
  }, [setTab, show]);
  // On an iPad, this Chat's simulators, designs and Browser open in the docked right panel; null where they open full screen.
  const { docks, openTab } = panels;
  const openInPanel = useMemo(() => (docks && !passive ? openTab : null), [docks, passive, openTab]);
  return { gesture, open: ours || passive ? panels.open : null, show, showPullRequest, showChanges, openInPanel };
}

/** The screen area a drag can start from; VoiceOver skips it while a panel covers it. */
export function PanelSwipe({
  panels,
  covered = false,
  children,
}: {
  panels: ReturnType<typeof useSidePanels>;
  /** Something drawn over the screen (the Tasks panel) has the screen reader instead. */
  covered?: boolean;
  children: React.ReactNode;
}) {
  const hidden = !!panels.open || covered;
  return (
    <GestureDetector gesture={panels.gesture}>
      <View style={{ flex: 1 }} accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}>
        {children}
      </View>
    </GestureDetector>
  );
}

function swipe({
  progress,
  from,
  width,
  min,
  max,
  offset,
  pull,
  settled,
  scale,
}: {
  progress: SharedValue<number>;
  from: SharedValue<number>;
  width: number;
  min: number;
  max: number;
  offset: [number, number];
  pull?: (side: Side) => void;
  settled: (to: number) => void;
  scale: number;
}) {
  // Each panel the finger reaches is drawn as it gets there, the other one too when the drag swings back past the screen.
  return Gesture.Pan()
    .activeOffsetX(offset)
    .failOffsetY([-SLOP_Y, SLOP_Y])
    .onStart(() => {
      from.set(progress.get());
    })
    .onUpdate((event) => {
      const previous = progress.get();
      const next = dragTo(from.get(), event.translationX, width, min, max);
      progress.set(next);
      const side = pull && entered(previous, next);
      if (side) scheduleOnRN(pull, side);
    })
    .onEnd((event) => {
      const to = settle(from.get(), progress.get(), event.velocityX);
      progress.set(springTo(to, SPRING, scale));
      scheduleOnRN(settled, to);
    });
}

/** Draws the panels over everything, the native header included; rendered once, after the navigator. */
export function SidePanelsHost() {
  const { colors } = useTheme();
  const session = useSession();
  const { screen, open, mounted, progress, from, show, settled, navigate, docks, chatTabs } = usePanels();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const cardTop = useCardTop();
  const scale = useMotionScale();
  // Wider than a phone, each panel is a card sliding over the Chat from its side instead of a whole page.
  const card = widthClass(width) !== "compact";
  const travel = panelTravel(width);
  const rightTravel = card ? CHANGES_WIDTH + CARD_MARGIN * 2 : width;
  const left = useAnimatedStyle(() => ({ transform: [{ translateX: (Math.max(progress.get(), 0) - 1) * travel }] }));
  const right = useAnimatedStyle(() => ({ transform: [{ translateX: (1 + Math.min(progress.get(), 0)) * rightTravel }] }));
  const shade = useAnimatedStyle(() => ({ opacity: Math.abs(progress.get()) }));
  // The navigation wakes (reloads its Projects, reads every computer) once it has slid all the way in, and sleeps once it
  // has slid all the way out: the renders that follow would otherwise land on the slide's frames and stutter it.
  const [leftAwake, setLeftAwake] = useState(false);
  useAnimatedReaction(
    () => (progress.get() >= 0.99 ? true : progress.get() <= 0.01 ? false : null),
    (now, before) => {
      if (now !== null && now !== before) scheduleOnRN(setLeftAwake, now);
    },
  );
  // The navigation's rows swipe only once it is all the way open.
  const leftOpen = useDerivedValue(() => progress.get() >= 0.99);
  // Closed, the navigation forgets a row left showing Done.
  useEffect(() => {
    if (!leftAwake) hideRevealed();
  }, [leftAwake]);
  // Made once per change of what it shows, so opening or closing the panel doesn't render the list again on the slide's
  // first frame.
  const activeChatId = screen?.chatId;
  const closePanel = useCallback(() => show(null), [show]);
  const navigation = useMemo(
    () => <ProjectNavigation visible={leftAwake} activeChatId={activeChatId} surface={card} onClose={closePanel} onNavigate={navigate} />,
    [leftAwake, activeChatId, card, closePanel, navigate],
  );
  // Open, only a drag back toward the screen closes it.
  const close = useMemo(
    () =>
      swipe({
        progress,
        from,
        width: travel,
        min: open === "right" ? -1 : 0,
        max: open === "left" ? 1 : 0,
        offset: open === "left" ? [-SLOP_X, 1e5] : [-1e5, SLOP_X],
        settled,
        scale,
      }).enabled(!!open),
    [progress, from, travel, open, settled, scale],
  );
  if (!screen || !session.client) return null;
  const frame = (side: Side) =>
    card
      ? ({
          position: "absolute",
          top: cardTop.top,
          bottom: Math.max(insets.bottom, CARD_MARGIN),
          [side]: CARD_MARGIN,
          width: side === "left" ? SIDEBAR_WIDTH : CHANGES_WIDTH,
          borderRadius: 18,
          borderCurve: "continuous",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          backgroundColor: colors.surface,
          overflow: "hidden",
        } as const)
      : [StyleSheet.absoluteFill, { backgroundColor: colors.page }];
  const hidden = (side: Side) =>
    ({ accessibilityElementsHidden: open !== side, importantForAccessibility: open === side ? "auto" : "no-hide-descendants" }) as const;
  return (
    <View pointerEvents={open ? "auto" : "none"} accessibilityViewIsModal={!!open} style={StyleSheet.absoluteFill}>
      {/* Outside a card (an iPad's panels), a tap on the dimmed screen closes the panel, as a sheet's backdrop does. */}
      <Animated.View pointerEvents={open && card ? "auto" : "none"} style={[StyleSheet.absoluteFill, { backgroundColor: colors.backdrop }, shade]}>
        <Pressable accessibilityLabel="Close panel" accessibilityRole="button" style={StyleSheet.absoluteFill} onPress={() => show(null)} />
      </Animated.View>
      <GestureDetector gesture={close}>
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {/* A card sits clear of the status bar already, so what it holds lays out with no safe area of its own, but for
          the window controls over the left card's corner. */}
          <SafeAreaInsetsContext.Provider value={card ? NO_INSETS : insets}>
            {mounted.left && (
              <Animated.View {...hidden("left")} style={[frame("left"), left]}>
                <SafeAreaInsetsContext.Provider value={card ? cardTop.content : insets}>
                  <ClosesLeftContext.Provider value={leftOpen}>{navigation}</ClosesLeftContext.Provider>
                </SafeAreaInsetsContext.Provider>
              </Animated.View>
            )}
            {/* Wide enough, the right panel docks beside the Chat instead (RightDock in split-layout.tsx). */}
            {mounted.right && !docks && rightTabs(screen, chatTabs).length > 0 && (
              <Animated.View {...hidden("right")} style={[frame("right"), right]}>
                <RightPanel screen={screen} card={card} visible={open === "right"} />
              </Animated.View>
            )}
          </SafeAreaInsetsContext.Provider>
        </View>
      </GestureDetector>
    </View>
  );
}

/**
 * The right panel, sliding over the Chat or docked beside it: the Worktree's Changes and the Chat's PRs, one tab each,
 * and on an iPad the Chat's simulators and designs. A file of the Changes opens in place with a Back button; a PR file
 * opens across the whole window on an iPad (wide enough to show it side by side), in the PR sheet on a phone.
 */
export function RightPanel({ screen, card, visible }: { screen: Screen; card: boolean; visible: boolean }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const { tab, setTab: onTab, pick, setPick: onPick, chatTabs, closeTab, closeRight: onClose } = usePanels();
  const { worktreeId, pullRequest } = screen;
  const tabs = rightTabs(screen, chatTabs);
  const shownTab = tabs.includes(tab) ? tab : tabs[0];
  const own = chatTabs && chatTabs.token === screen.token && chatTabs.chatId === screen.chatId ? chatTabs : null;
  // The Changes list stays mounted under the other tabs, so going back keeps its folders and scroll; it is read again
  // only for another Worktree.
  const changesKey = `${session.snapshot?.project.path}#${worktreeId}`;
  const [file, setFile] = useState<DiffTarget | null>(null);
  const [fileKey, setFileKey] = useState(changesKey);
  if (fileKey !== changesKey) {
    setFileKey(changesKey);
    setFile(null);
  }
  const choices = pullRequest?.choices ?? [];
  // The picked PR while the Chat still lists it, else the one its row shows first.
  const picked = pick !== null ? choices.find((choice) => prChoiceKey(choice) === pick) : undefined;
  const number = picked?.number ?? pullRequest?.number;
  const pr = shownTab === "pr" && pullRequest && number ? { number, chatKey: pullRequest.chatKey } : undefined;
  // A Link Chat's PR is read in its own Project's Worktree; a Project's Chat, in the Chat's Worktree.
  const prCwd = picked ? picked.cwd : pullRequest?.cwd;
  const shown = picked ?? choices.find((choice) => choice.number === number && choice.cwd === prCwd);
  const prProject = shown?.project && shown.projectPath ? { name: shown.project, path: shown.projectPath } : undefined;
  const cwd = prCwd ?? (worktreeId !== undefined ? session.snapshot?.project.state.worktrees[worktreeId]?.path : undefined);
  const route =
    pr && worktreeId !== undefined ? { worktreeId: String(worktreeId), number: String(pr.number), chat: pr.chatKey, ...(prCwd ? { cwd: prCwd } : {}) } : null;
  // One tab per PR of the Chat; before its row lists them, the one it opened.
  const prTabs: PrChoice[] = choices.length ? choices : pullRequest ? [{ number: pullRequest.number, title: "", state: "OPEN", cwd: pullRequest.cwd }] : [];
  const designs = own?.designs;
  const closeLabel = shownTab === "pr" ? "Close the PR" : shownTab === "changes" ? "Close Changes" : "Close the panel";
  return (
    <View style={{ flex: 1 }}>
      {/* One compact row: the tabs scroll sideways, the close button keeps its place at the end, centred with them. */}
      <View style={{ marginTop: insets.top, height: 52, paddingLeft: 8, paddingRight: 6, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          style={{ flex: 1, alignSelf: "stretch" }}
          contentContainerStyle={{ gap: 2, alignItems: "center" }}
        >
          {tabs.includes("changes") && (
            <PanelTab label="Changes" icon={FileDiffIcon} tone="ink2" selected={shownTab === "changes"} onPress={() => onTab("changes")} />
          )}
          {tabs.includes("pr") &&
            prTabs.map((choice) => (
              <PanelTab
                key={prChoiceKey(choice)}
                label={`#${choice.number}`}
                icon={PR_ICONS[choice.look?.icon ?? (choice.state === "MERGED" ? "merged" : choice.state === "CLOSED" ? "closed" : "open")]}
                tone={
                  choice.look?.tone === "purple" || (!choice.look && choice.state === "MERGED")
                    ? "purpleInk"
                    : (choice.look?.tone ?? (choice.state === "CLOSED" ? "ink3" : "green"))
                }
                selected={!!pr && choice.number === number && (!choice.cwd || choice.cwd === prCwd)}
                onPress={() => {
                  onPick(prChoiceKey(choice));
                  onTab("pr");
                }}
              />
            ))}
          {own?.simulator && (
            <PanelTab label="Simulator" icon={SmartphoneIcon} tone="ink2" selected={shownTab === "simulator"} onPress={() => onTab("simulator")} />
          )}
          {own?.browser && <PanelTab label="Browser" icon={BrowserIcon} tone="ink2" selected={shownTab === "browser"} onPress={() => onTab("browser")} />}
          {designs && (
            <PanelTab
              label={designs.html ? "Artifact" : "Designs"}
              icon={designs.html ? File01Icon : PaintBoardIcon}
              tone="ink2"
              selected={shownTab === "designs"}
              onPress={() => onTab("designs")}
            />
          )}
        </ScrollView>
        <GlassIconButton label={closeLabel} systemImage="xmark" icon={Cancel01Icon} onPress={onClose} />
      </View>
      {file && shownTab === "changes" && (
        <View style={{ paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <IconButton label="Back to Changes" icon={ArrowLeft01Icon} size={44} onPress={() => setFile(null)} />
          <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 17, fontWeight: "600" }}>
            {file.path.split("/").pop() || file.path}
          </Text>
        </View>
      )}
      {worktreeId !== undefined && (
        <View style={{ flex: 1, display: file || shownTab !== "changes" ? "none" : "flex" }}>
          {/* Hidden, it stops polling the Mac: under the PR tab its reads and re-renders slowed the whole app. */}
          <ChangesShownContext.Provider value={visible && !file && shownTab === "changes"}>
            <ChangesView key={changesKey} worktreeId={worktreeId} onOpen={setFile} />
          </ChangesShownContext.Provider>
        </View>
      )}
      {file && shownTab === "changes" && (
        <View style={{ flex: 1 }}>
          <DiffView target={file} />
        </View>
      )}
      {pr && route && cwd && session.client && (
        <PrOverview
          key={`${cwd}#${pr.number}`}
          client={session.client}
          cwd={cwd}
          number={pr.number}
          chatKey={pr.chatKey}
          project={prProject}
          onChanges={() => {
            setFile(null);
            onTab("changes");
          }}
          onChat={onClose}
          onOpen={(page, extra) => {
            if (page === "diff" && card && extra?.path) {
              onClose();
              openPrFile(route, extra.path);
            } else openPrPage(page, route, extra);
          }}
        />
      )}
      {/* The device streams only while its tab shows: hidden, its WebView would be gone from under the stream. */}
      {own?.simulator && shownTab === "simulator" && (
        <View style={{ flex: 1 }}>
          <SimulatorSheet
            key={`${own.simulator.hostId}:${own.simulator.chatId}`}
            hostId={own.simulator.hostId}
            chatId={own.simulator.chatId}
            onClose={() => closeTab("simulator")}
          />
        </View>
      )}
      {/* Keep the Browser selection while hidden, but stop its live capture. */}
      {own?.browser && (
        <View style={{ flex: 1, display: shownTab === "browser" ? "flex" : "none" }}>
          <BrowserSheet
            key={`${own.browser.hostId}:${own.browser.chatId}`}
            {...own.browser}
            visible={visible && shownTab === "browser"}
            onClose={() => closeTab("browser")}
          />
        </View>
      )}
      {/* The designs canvas stays drawn under the other tabs, so a visit doesn't load it again. It is hidden by opacity:
      with display none the native WebView goes away and the canvas's messages to it fail. */}
      {designs && (
        <View
          pointerEvents={shownTab === "designs" ? "auto" : "none"}
          accessibilityElementsHidden={shownTab !== "designs"}
          importantForAccessibility={shownTab === "designs" ? "auto" : "no-hide-descendants"}
          style={shownTab === "designs" ? { flex: 1 } : { position: "absolute", top: insets.top + 52, left: 0, right: 0, bottom: 0, opacity: 0 }}
        >
          {designs.html ? (
            <ArtifactSheet
              key={`${designs.hostId}:${designs.chatId}:${designs.id}`}
              hostId={designs.hostId}
              chatId={designs.chatId}
              id={designs.id}
              tab={designs.tab}
              comment={designs.comment}
              requestId={designs.requestId}
              onClose={() => closeTab("designs")}
            />
          ) : (
            <DesignsSheet
              key={`${designs.hostId}:${designs.chatId}:${designs.id}:${designs.version}`}
              hostId={designs.hostId}
              chatId={designs.chatId}
              id={designs.id}
              version={designs.version}
              chosen={designs.chosen}
              onClose={() => closeTab("designs")}
            />
          )}
        </View>
      )}
    </View>
  );
}

/** A tab of the right panel: Changes, one of the Chat's PRs with its state's icon, or the Chat's simulators or designs. */
function PanelTab({ label, icon, tone, selected, onPress }: { label: string; icon: IconData; tone: Tone; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        height: 32,
        paddingHorizontal: 11,
        borderRadius: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: selected || pressed ? colors.hover : "transparent",
      })}
    >
      <Icon icon={icon} tone={tone} size={15} />
      <Text style={{ color: selected ? colors.ink : colors.ink2, fontSize: 15, fontWeight: selected ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
}
