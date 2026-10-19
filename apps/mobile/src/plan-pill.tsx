import { memo, useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import {
  AccessibilityInfo,
  BackHandler,
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type TextInstance,
  type ViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ArrowShrink02Icon, ListTodoIcon } from "@hugeicons/core-free-icons";
import { taskCounts } from "@milagre/shared/chat-plan";
import type { ChatPlan } from "@milagre/shared/model";
import { Icon } from "./icons";
import { planPillLabel } from "./plan-label";
import { morphRect, planPanelFrame } from "./plan-panel-frame";
import { PlanPhaseGraph, PlanTree } from "./plan-view";
import { useMotionScale, useReducedMotion } from "./motion";
import { useTheme } from "./theme";
import { IconButton, PageScroll } from "./ui";

// Desktop's morph: 300 ms on this curve, the hidden face fading in 100 ms and the shown one in 180 ms after 60 ms.
const EASE = Easing.bezier(0.16, 1, 0.3, 1);
// A downward drag on the header this long, or this fast, closes the panel.
const DRAG_CLOSE = 72;
const FLING_CLOSE = 900;
// An iOS overscroll this far past the top of the body closes it too.
const PULL_CLOSE = 56;

type Box = { x: number; y: number; width: number; height: number };
type Phase = "closed" | "open" | "closing";

/**
 * The Tasks pill's state, shared by the pill in the composer row and the panel drawn over the Chat. The composer clips
 * its children, so the panel lives in an overlay at the screen's root and grows from where the pill was measured.
 */
export function usePlanPanel(plan: ChatPlan | undefined, chatId: string) {
  const label = planPillLabel(plan);
  const [state, setState] = useState<{ phase: Phase; chatId: string }>({ phase: "closed", chatId });
  const [pill, setPill] = useState<Box | null>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const [keyboard, setKeyboard] = useState(0);
  // Each opening draws a fresh phase graph, so its Now is the moment the panel opened.
  const [opening, setOpening] = useState(0);
  const chip = useRef<ViewInstance | null>(null);
  const overlay = useRef<ViewInstance | null>(null);
  const refocus = useRef(false);
  // The plan goes with its Chat: when it is gone, or this is another Chat, the panel is closed at once.
  const stale = state.phase !== "closed" && (!label || state.chatId !== chatId);
  if (stale) setState({ phase: "closed", chatId });
  const phase = stale ? "closed" : state.phase;
  const attachChip = useCallback((node: ViewInstance | null) => {
    chip.current = node;
  }, []);
  const attachOverlay = useCallback((node: ViewInstance | null) => {
    overlay.current = node;
  }, []);
  const measure = useCallback((then?: () => void) => {
    chip.current?.measureInWindow((x, y, width, height) => {
      if (!width || !height) return;
      const place = (ox: number, oy: number) => {
        setPill({ x, y, width, height });
        setOrigin({ x: ox, y: oy });
        setKeyboard(Keyboard.isVisible() ? (Keyboard.metrics()?.height ?? 0) : 0);
        then?.();
      };
      if (overlay.current) overlay.current.measureInWindow((ox, oy) => place(ox, oy));
      else place(0, 0);
    });
  }, []);
  const show = useCallback(
    () =>
      measure(() => {
        setOpening((count) => count + 1);
        setState({ phase: "open", chatId });
      }),
    [measure, chatId],
  );
  const close = useCallback(() => setState((current) => (current.phase === "open" ? { ...current, phase: "closing" } : current)), []);
  const settle = useCallback(() => {
    refocus.current = true;
    setState((current) => (current.phase === "closing" ? { ...current, phase: "closed" } : current));
  }, []);
  // The open panel follows the pill wherever the composer takes it: a rotation (once the screen has laid out again), the
  // keyboard rising or falling (the composer rides it; these events come once it has landed), or the row relaying out.
  useEffect(() => {
    if (phase !== "open") return;
    let frame = 0;
    const follow = () => measure();
    const subscriptions = [
      Dimensions.addEventListener("change", () => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(follow);
      }),
      Keyboard.addListener("keyboardDidShow", follow),
      Keyboard.addListener("keyboardDidHide", follow),
      ...(Platform.OS === "ios" ? [Keyboard.addListener("keyboardDidChangeFrame", follow)] : []),
    ];
    return () => {
      if (frame) cancelAnimationFrame(frame);
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [phase, measure]);
  const relayout = useCallback(() => {
    if (phase === "open") measure();
  }, [phase, measure]);
  useEffect(() => {
    if (phase !== "open") return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => back.remove();
  }, [phase, close]);
  // Landing back in the composer, the pill takes the screen reader's focus again.
  useEffect(() => {
    if (phase !== "closed" || !refocus.current) return;
    refocus.current = false;
    if (chip.current) AccessibilityInfo.sendAccessibilityEvent(chip.current, "focus");
  }, [phase]);
  // The same object until something here changes, so the memoized pill and panel skip the Chat's other renders (typing).
  return useMemo(
    () => ({ plan, label, phase, pill, origin, keyboard, opening, attachChip, attachOverlay, show, close, settle, relayout }),
    [plan, label, phase, pill, origin, keyboard, opening, attachChip, attachOverlay, show, close, settle, relayout],
  );
}

export type PlanPanelState = ReturnType<typeof usePlanPanel>;

function PillFace({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ minHeight: 34, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Icon icon={ListTodoIcon} tone="ink2" size={15} />
      <Text style={{ color: colors.ink2, fontSize: 13, fontVariant: ["tabular-nums"] }}>{label}</Text>
    </View>
  );
}

/** Desktop's Tasks pill: done/total (or the current phase) in the composer row; a tap grows it into the panel. Hidden without a plan. */
export const PlanPill = memo(function PlanPill({ panel }: { panel: PlanPanelState }) {
  const { label, plan, phase, show, attachChip, relayout } = panel;
  if (!label || !plan) return null;
  const { done, total } = taskCounts(plan.tasks);
  // While the surface is out, it is the pill: this one keeps its place in the row, invisible.
  const away = phase !== "closed";
  return (
    <Pressable
      ref={attachChip}
      collapsable={false}
      accessibilityRole="button"
      accessibilityLabel={total ? `Tasks, ${done} of ${total} done` : `Phase: ${label}`}
      accessibilityHint="Opens the task list and phase graph"
      accessibilityState={{ expanded: away }}
      accessibilityElementsHidden={away}
      importantForAccessibility={away ? "no-hide-descendants" : "auto"}
      disabled={away}
      onPress={show}
      // A new label (1/2 to 2/2) resizes the pill; an open panel keeps growing from its new frame.
      onLayout={relayout}
      style={({ pressed }) => ({ opacity: away ? 0 : pressed ? 0.6 : 1 })}
    >
      <PillFace label={label} />
    </Pressable>
  );
});

function SectionLabel({ title, count, textRef }: { title: string; count?: number; textRef?: Ref<TextInstance> }) {
  const { colors } = useTheme();
  const text = { color: colors.ink3, fontSize: 11, fontWeight: "500", letterSpacing: 0.9, textTransform: "uppercase" } as const;
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Text ref={textRef} accessibilityRole="header" style={text}>
        {title}
      </Text>
      {count !== undefined && <Text style={[text, { fontVariant: ["tabular-nums"] }]}>{count}</Text>}
    </View>
  );
}

/**
 * The Tasks panel: the pill's surface grown over the Chat, a fixed "Tasks" header with the leaf total and a collapse
 * control above the tree and phase graph, which scroll as one body. Both faces stay mounted and crossfade while the
 * surface's frame and corners move; the backdrop, the collapse control, a swipe down on the header and Android back
 * fold it back into the pill. Render it once, over the transcript and the composer.
 */
export const PlanPanel = memo(function PlanPanel({ panel }: { panel: PlanPanelState }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  const scale = useMotionScale();
  const [header, setHeader] = useState(0);
  const [body, setBody] = useState(0);
  const progress = useSharedValue(0);
  const drag = useSharedValue(0);
  const pillFace = useSharedValue(1);
  const panelFace = useSharedValue(0);
  const heading = useRef<TextInstance>(null);
  const { plan, label, phase, close, settle, opening, attachOverlay, keyboard, origin } = panel;
  // Before the first opening the pill is unmeasured; the panel still lays out at its real width so its height is known.
  const pill = panel.pill ?? { x: window.width - 80, y: window.height - insets.bottom - 64, width: 60, height: 34 };
  const { from, to } = planPanelFrame({ window, insets, pill, content: header + body, keyboard, origin });
  const surfaceStyle = useAnimatedStyle(() => {
    const rect = morphRect(from, to, progress.get());
    return { left: rect.x, top: rect.y, width: rect.width, height: rect.height, borderRadius: rect.radius, transform: [{ translateY: drag.get() }] };
  });
  const fillStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, progress.get() * 4) }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.get() * (1 - Math.min(1, drag.get() / 320)) }));
  const pillStyle = useAnimatedStyle(() => ({ opacity: pillFace.get() }));
  const panelStyle = useAnimatedStyle(() => ({ opacity: panelFace.get() }));
  useEffect(() => {
    const timing = (duration: number) => ({ duration: reduced ? 0 : Math.round(duration * scale), easing: EASE, reduceMotion: ReduceMotion.System });
    const later = reduced ? 0 : Math.round(60 * scale);
    if (phase === "open") {
      progress.set(withTiming(1, timing(300)));
      pillFace.set(withTiming(0, timing(100)));
      panelFace.set(withDelay(later, withTiming(1, timing(180))));
    } else if (phase === "closing") {
      panelFace.set(withTiming(0, timing(100)));
      pillFace.set(withDelay(later, withTiming(1, timing(180))));
      drag.set(withTiming(0, timing(300)));
      progress.set(
        withTiming(0, timing(300), (finished) => {
          if (finished) scheduleOnRN(settle);
        }),
      );
    } else {
      for (const value of [progress, drag, pillFace, panelFace]) cancelAnimation(value);
      progress.set(0);
      drag.set(0);
      pillFace.set(1);
      panelFace.set(0);
    }
  }, [phase, reduced, scale, settle, progress, drag, pillFace, panelFace]);
  // Opening moves the screen reader into the panel, onto its heading, as desktop focuses the dialog.
  useEffect(() => {
    if (phase === "open" && heading.current) AccessibilityInfo.sendAccessibilityEvent(heading.current, "focus");
  }, [phase]);
  const pan = usePanGesture({
    activeOffsetY: 8,
    failOffsetX: [-24, 24],
    onUpdate: (event) => {
      "worklet";
      drag.set(Math.max(0, event.translationY));
    },
    onDeactivate: (event) => {
      "worklet";
      if (!event.canceled && (event.translationY > DRAG_CLOSE || event.velocityY > FLING_CLOSE)) scheduleOnRN(close);
      else drag.set(withTiming(0, { duration: Math.round(200 * scale), easing: EASE, reduceMotion: ReduceMotion.System }));
    },
  });
  if (!plan || !label) return null;
  const open = phase === "open";
  const shown = phase !== "closed";
  const tasks = plan.tasks.length > 0;
  const { total } = taskCounts(plan.tasks);
  const inert = { pointerEvents: "none", accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;
  return (
    <View
      ref={attachOverlay}
      collapsable={false}
      pointerEvents={shown ? "box-none" : "none"}
      // Open, VoiceOver stays inside: the backdrop's Close tasks and the card. The Chat behind hides itself on Android.
      accessibilityViewIsModal={open}
      onAccessibilityEscape={close}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      style={[StyleSheet.absoluteFill, { opacity: shown ? 1 : 0 }]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.backdrop }, backdropStyle]}>
        <Pressable
          testID="plan-backdrop"
          accessibilityRole="button"
          accessibilityLabel="Close tasks"
          disabled={!open}
          onPress={close}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      {/* The card itself: fades in as it leaves the pill, which has no fill of its own in the composer. */}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.lineStrong,
            borderCurve: "continuous",
            boxShadow: "0 8px 32px #0000002e",
          },
          surfaceStyle,
          fillStyle,
        ]}
      />
      <Animated.View testID="plan-surface" style={[{ position: "absolute", overflow: "hidden", borderCurve: "continuous" }, surfaceStyle]}>
        {/* Anchored to the surface's bottom-right at its final size, so the growing surface uncovers it. */}
        <Animated.View
          testID="plan-panel"
          role="dialog"
          accessibilityLabel="Tasks"
          {...(open ? {} : inert)}
          style={[{ position: "absolute", right: 0, bottom: 0, width: to.width, height: to.height }, panelStyle]}
        >
          <GestureDetector gesture={pan}>
            <View
              onLayout={({ nativeEvent }) => setHeader(Math.ceil(nativeEvent.layout.height))}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 16, paddingRight: 6, paddingTop: 6 }}
            >
              <SectionLabel title={tasks ? "Tasks" : "Phase graph"} count={tasks ? total : undefined} textRef={heading} />
              <IconButton label="Collapse tasks" icon={ArrowShrink02Icon} tone="ink3" size={36} onPress={close} />
            </View>
          </GestureDetector>
          {/* The tree and the graph scroll as one body under the fixed header. */}
          <PageScroll
            nestedScrollEnabled
            contentInsetAdjustmentBehavior="never"
            // Scrolling here must not drop the keyboard: the composer would move the pill out from under the card.
            keyboardDismissMode="none"
            onContentSizeChange={(_, height) => setBody(Math.ceil(height))}
            onScrollEndDrag={({ nativeEvent }) => {
              if (nativeEvent.contentOffset.y < -PULL_CLOSE) close();
            }}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16, gap: 20 }}
          >
            {tasks && <PlanTree plan={plan} />}
            {plan.phases.length > 0 && (
              <View style={{ gap: 10 }}>
                {tasks && (
                  <View style={{ flexDirection: "row", paddingHorizontal: 4 }}>
                    <SectionLabel title="Phase graph" />
                  </View>
                )}
                <PlanPhaseGraph key={opening} plan={plan} />
              </View>
            )}
          </PageScroll>
        </Animated.View>
      </Animated.View>
      {/* The pill face stays at the pill's spot and fades as the surface grows out of it. */}
      <Animated.View {...inert} style={[{ position: "absolute", left: from.x, top: from.y, width: from.width, height: from.height }, pillStyle]}>
        <PillFace label={label} />
      </Animated.View>
    </View>
  );
});
