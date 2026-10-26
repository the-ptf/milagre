import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Keyboard, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { router, useFocusEffect, useNavigation, type Href } from "expo-router";
import { SafeAreaInsetsContext, useSafeAreaInsets, type EdgeInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, ReduceMotion, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ArrowLeft01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { useSession } from "./session";
import { ProjectNavigation } from "./project-navigation";
import { ChangesView } from "./app/changes";
import { DiffView, type DiffTarget } from "./app/diff";
import { IconButton } from "./ui";
import { PrOverview } from "./pr-overview";
import { PrFiles } from "./pr-lists";
import { openPrFile, openPrPage } from "./pr-nav";
import { prChoiceKey, type PrChoice } from "./pr-chat";
import type { DiffMode } from "@milagre/shared/git-diff";
import { springTo, scaledTiming, useMotionScale } from "./motion";
import { getMotionScale, useTheme } from "./theme";
import { dragTo, entered, settle } from "./panel-motion";
import { useCardTop, useSplitLayout } from "./split-context";
import { CARD_MARGIN, CHANGES_WIDTH, SIDEBAR_WIDTH, widthClass } from "./split-width";

type Side = "left" | "right";
/** What the focused screen offers: the left panel always, Changes when it has a Worktree, its PR beside Changes when it has one. */
type Screen = { token: object; chatId?: number; worktreeId?: number; pullRequest?: ScreenPullRequest };
/** The Chat's PR the panel opens on, and every PR its row lists for the PR menu. */
type ScreenPullRequest = { number: number; chatKey: string; choices?: PrChoice[]; cwd?: string };
/** What the right panel shows: the PR (when the Chat has one), or the Worktree's Changes. */
type RightTab = "changes" | "pr";
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
  tab: RightTab;
  setTab: (tab: RightTab) => void;
  /** The mode Changes opens in, and a count that remounts it there when asked again. */
  changesMode: { mode: DiffMode; nonce: number };
  setChangesMode: (mode: DiffMode) => void;
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
  const [pick, setPick] = useState<string | null>(null);
  const [changesMode, setChangesModeState] = useState<{ mode: DiffMode; nonce: number }>({ mode: "uncommitted", nonce: 0 });
  const setChangesMode = useCallback((mode: DiffMode) => setChangesModeState((previous) => ({ mode, nonce: previous.nonce + 1 })), []);
  const [mounted, setMounted] = useState<Record<Side, boolean>>({ left: false, right: false });
  const current = useRef<Screen | null>(null);
  const openSide = useRef<Side | null>(null);
  // While a Chat picked in the open navigation replaces the screen under it: the timer that slides the navigation away
  // regardless, and the screen that took the panels, until its own transition ends.
  const handoff = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        return;
      }
      if (current.current?.token !== next.token) reset();
      current.current = next;
      setScreen(next);
    },
    [reset],
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
      Keyboard.dismiss();
      if (side) setMounted((previous) => (previous[side] ? previous : { ...previous, [side]: true }));
      setOpen(side);
      progress.set(springTo(side === "left" ? 1 : side === "right" ? -1 : 0, SPRING, getMotionScale()));
    },
    [progress],
  );
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
      tab,
      setTab,
      changesMode,
      setChangesMode,
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
      tab,
      setTab,
      changesMode,
      setChangesMode,
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

/** The focused screen's Chat and Worktree, and the panels it offers, for the pinned sidebar and keyboard shortcuts. */
export function usePanelScreen() {
  const { screen, open, show } = usePanels();
  return { attached: !!screen, chatId: screen?.chatId, worktreeId: screen?.worktreeId, open, show };
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
  const { attach, update, detach, arrived, show, pull, settled, progress, from, setTab, setPick, setChangesMode } = panels;
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
        min: worktreeId === undefined ? 0 : -1,
        max: dockable ? 0 : 1,
        offset: [-SLOP_X, SLOP_X],
        pull,
        settled,
        scale,
      }).enabled(!passive && ours && !panels.open),
    [progress, from, travel, worktreeId, dockable, pull, settled, ours, passive, panels.open, scale],
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
  const showChanges = useCallback(
    (mode?: DiffMode) => {
      if (mode) setChangesMode(mode);
      setTab("changes");
      show("right");
    },
    [setTab, setChangesMode, show],
  );
  return { gesture, open: ours || passive ? panels.open : null, show, showPullRequest, showChanges };
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
  const { screen, open, mounted, progress, from, show, settled, navigate, tab, setTab, changesMode, setChangesMode, pick, setPick } = usePanels();
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
                <SafeAreaInsetsContext.Provider value={card ? cardTop.content : insets}>{navigation}</SafeAreaInsetsContext.Provider>
              </Animated.View>
            )}
            {mounted.right && screen.worktreeId !== undefined && (
              <Animated.View {...hidden("right")} style={[frame("right"), right]}>
                <ChangesPanel
                  key={`${session.snapshot?.project.path}#${screen.worktreeId}`}
                  worktreeId={screen.worktreeId}
                  pullRequest={screen.pullRequest}
                  tab={screen.pullRequest ? tab : "changes"}
                  onTab={setTab}
                  pick={pick}
                  onPick={setPick}
                  changesMode={changesMode}
                  onChangesMode={setChangesMode}
                  card={card}
                  onClose={() => show(null)}
                />
              </Animated.View>
            )}
          </SafeAreaInsetsContext.Provider>
        </View>
      </GestureDetector>
    </View>
  );
}

/**
 * The Chat's PR when its branch opened one, else the Worktree's Changes. The PR opens on its overview with no header of its
 * own (its top row has the X); its files, the Changes not in it yet and a file's diff open in place with a Back button, so
 * reading one never leaves the panel. A PR file opens across the whole window on an iPad (wide enough to show it side by
 * side), in the PR sheet on a phone.
 */
function ChangesPanel({
  worktreeId,
  pullRequest,
  tab,
  onTab,
  pick,
  onPick,
  changesMode,
  onChangesMode,
  card,
  onClose,
}: {
  worktreeId: number;
  pullRequest?: ScreenPullRequest;
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  pick: string | null;
  onPick: (key: string | null) => void;
  changesMode: { mode: DiffMode; nonce: number };
  onChangesMode: (mode: DiffMode) => void;
  card: boolean;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [file, setFile] = useState<DiffTarget | null>(null);
  const [prFiles, setPrFiles] = useState(false);
  const choices = pullRequest?.choices ?? [];
  // The picked PR while the Chat still lists it, else the one its row shows first.
  const picked = pick !== null ? choices.find((choice) => prChoiceKey(choice) === pick) : undefined;
  const number = picked?.number ?? pullRequest?.number;
  const pr = tab === "pr" && pullRequest && number ? { number, chatKey: pullRequest.chatKey } : undefined;
  // A Link Chat's PR is read in its own Project's Worktree; a Project's Chat, in the Chat's Worktree.
  const prCwd = picked ? picked.cwd : pullRequest?.cwd;
  const shown = picked ?? choices.find((choice) => choice.number === number && choice.cwd === prCwd);
  const prProject = shown?.project && shown.projectPath ? { name: shown.project, path: shown.projectPath } : undefined;
  const cwd = prCwd ?? session.snapshot?.project.state.worktrees[worktreeId]?.path;
  const chatId = pullRequest ? Number(pullRequest.chatKey.slice(pullRequest.chatKey.lastIndexOf("#") + 1)) : NaN;
  const provider = Number.isSafeInteger(chatId) ? session.snapshot?.project.state.sessions[chatId]?.provider : undefined;
  const route = pr ? { worktreeId: String(worktreeId), number: String(pr.number), chat: pr.chatKey, ...(prCwd ? { cwd: prCwd } : {}) } : null;
  // Back from a PR's files to the PR, from a diff to Changes, from Changes to the PR.
  const back = pr ? () => setPrFiles(false) : file ? () => setFile(null) : pullRequest ? () => onTab("pr") : null;
  const name = pr ? "Files" : file ? file.path.split("/").pop() || file.path : "Changes";
  const overview = !!(pr && route && cwd && session.client && !prFiles);
  return (
    <View style={{ flex: 1 }}>
      {overview ? (
        <View style={{ height: insets.top + 8 }} />
      ) : (
        <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, paddingBottom: 4, flexDirection: "row", alignItems: "center", gap: 4 }}>
          {back && <IconButton label={pr || !file ? "Back to the PR" : "Back to Changes"} icon={ArrowLeft01Icon} size={44} onPress={back} />}
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ flex: 1, paddingLeft: back ? 0 : 12, color: colors.ink, fontSize: back ? 17 : 22, fontWeight: back ? "600" : "700" }}
          >
            {name}
          </Text>
          <IconButton label={pr ? "Close the PR" : "Close Changes"} icon={Cancel01Icon} size={44} onPress={onClose} />
        </View>
      )}
      {/* The list stays mounted under a diff, so going back keeps its mode, folders and scroll. */}
      <View style={{ flex: 1, display: file || pr ? "none" : "flex" }}>
        <ChangesView key={changesMode.nonce} worktreeId={worktreeId} onOpen={setFile} initialMode={changesMode.mode} />
      </View>
      {file && !pr && (
        <View style={{ flex: 1 }}>
          <DiffView target={file} />
        </View>
      )}
      {overview && route && cwd && session.client && pr && (
        <PrOverview
          key={`${cwd}#${pr.number}`}
          client={session.client}
          cwd={cwd}
          number={pr.number}
          chatKey={pr.chatKey}
          provider={provider}
          onClose={onClose}
          choices={choices}
          project={prProject}
          onPick={(next) => {
            setPrFiles(false);
            onPick(next);
          }}
          onChanges={(mode) => {
            setFile(null);
            onChangesMode(mode);
            onTab("changes");
          }}
          onChat={onClose}
          onOpen={(page, extra) => {
            if (page === "files") setPrFiles(true);
            else openPrPage(page, route, extra);
          }}
        />
      )}
      {pr && route && cwd && session.client && prFiles && (
        <PrFiles
          client={session.client}
          cwd={cwd}
          number={pr.number}
          onOpenFile={(entry) => {
            if (card) {
              onClose();
              openPrFile(route, entry.path);
            } else openPrPage("diff", route, { path: entry.path });
          }}
        />
      )}
    </View>
  );
}
