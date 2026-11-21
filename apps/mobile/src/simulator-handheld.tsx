import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BackHandler, Modal, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, useCompetingGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { cancelAnimation, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as SecureStore from "expo-secure-store";
import { useKeepAwake } from "expo-keep-awake";
import { ArrowLeft01Icon, Home01Icon, MinimizeScreenIcon, Refresh01Icon, Rotate01Icon, TouchInteraction01Icon } from "@hugeicons/core-free-icons";
import type { SimulatorConnectionState } from "@milagre/shared/simulator-receiver";
import { createHandheldSpotStore, DEFAULT_HANDHELD_SPOT, handheldSpotPoint, landHandheldSpot } from "./handheld-spot";
import { Icon, type IconData } from "./icons";
import { duration, lineHeight, radius, space, type } from "./design-tokens";
import { springTo, useMotionScale } from "./motion";
import { GlassSurface } from "./primitives/glass-surface";
import { pressStyle } from "./primitives/press-style";
import { tap } from "./primitives/tap";
import { useTheme } from "./theme";

const SIZE = 52;
const FADED = 0.4;
const SPRING = { duration: duration.slow, dampingRatio: 0.85, overshootClamping: true, reduceMotion: ReduceMotion.System };
const spots = createHandheldSpotStore(SecureStore);

export type HandheldAction = "home" | "back" | "rotate" | "control" | "retry";
type Item = { action: HandheldAction | "exit"; label: string; icon: IconData; disabled?: boolean };

/** What the menu offers in a connection state. The helper has no App Switcher button, so the menu has none either. */
function handheldMenu(state: SimulatorConnectionState, android: boolean): Item[] {
  const live = state === "live";
  return [
    { action: "home", label: "Home", icon: Home01Icon, disabled: !live },
    ...(android ? [{ action: "back", label: "Back", icon: ArrowLeft01Icon, disabled: !live } as const] : []),
    { action: "rotate", label: "Rotate", icon: Rotate01Icon, disabled: !live },
    ...(state === "view-only" ? [{ action: "control", label: "Take control", icon: TouchInteraction01Icon } as const] : []),
    ...(state === "error" || state === "paused" ? [{ action: "retry", label: "Reconnect", icon: Refresh01Icon } as const] : []),
    { action: "exit", label: "Exit handheld", icon: MinimizeScreenIcon },
  ];
}

/** Handheld mode belongs to the device it was entered for, while its viewer is on screen. `fullscreen` where the viewer page itself goes black and bare (a phone). */
export function useHandheldMode(deviceId: string | undefined, shown: boolean, docked: boolean) {
  const [entered, setEntered] = useState<string | null>(null);
  const handheld = shown && !!deviceId && entered === deviceId;
  const enter = useCallback(() => setEntered(deviceId ?? null), [deviceId]);
  const exit = useCallback(() => setEntered(null), []);
  return { handheld, fullscreen: handheld && !docked, enter, exit };
}

/** On an iPad the viewer sits in the side panel, so handheld mode takes it to a full-screen modal; a phone's viewer is already full screen. */
export function HandheldStage({ docked, handheld, onExit, children }: { docked: boolean; handheld: boolean; onExit: () => void; children: ReactNode }) {
  const { colors } = useTheme();
  if (!docked || !handheld) return <>{children}</>;
  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]}
      statusBarTranslucent
      onRequestClose={onExit}
    >
      <View style={{ flex: 1, backgroundColor: colors.media }}>{children}</View>
    </Modal>
  );
}

/**
 * Handheld mode's one control over the simulator's screen: a small glass button, faded until touched, that drags
 * anywhere and settles against the nearer side edge, where it stays across sessions. A tap opens a centred menu;
 * the backdrop under the menu takes every touch, so none reaches the simulator. The screen stays awake meanwhile.
 */
export function HandheldControls({
  state,
  android,
  onAction,
  onExit,
}: {
  state: SimulatorConnectionState;
  android: boolean;
  onAction: (action: HandheldAction) => void;
  onExit: () => void;
}) {
  useKeepAwake("milagre-handheld");
  const { colors } = useTheme();
  const frame = useSafeAreaFrame(),
    insets = useSafeAreaInsets();
  const left = insets.left + space.md,
    top = insets.top + space.md;
  const width = Math.max(SIZE, frame.width - left - insets.right - space.md),
    height = Math.max(SIZE, frame.height - top - insets.bottom - space.md);
  const [spot, setSpot] = useState(spots.peek);
  const [menu, setMenu] = useState(false);
  const scale = useMotionScale();
  const start = handheldSpotPoint(spot ?? DEFAULT_HANDHELD_SPOT, SIZE, width, height);
  const x = useSharedValue(start.x),
    y = useSharedValue(start.y),
    fromX = useSharedValue(0),
    fromY = useSharedValue(0),
    fade = useSharedValue(FADED);
  useEffect(() => {
    let live = true;
    void spots.load().then((saved) => live && setSpot(saved));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!spot) return;
    const point = handheldSpotPoint(spot, SIZE, width, height);
    x.set(springTo(point.x, SPRING, scale));
    y.set(springTo(point.y, SPRING, scale));
  }, [spot, width, height, x, y, scale]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (menu) setMenu(false);
      else onExit();
      return true;
    });
    return () => subscription.remove();
  }, [menu, onExit]);
  const settle = useCallback(
    (atX: number, atY: number) => {
      const next = landHandheldSpot(atX, atY, SIZE, width, height);
      setSpot(next);
      void spots.save(next);
    },
    [width, height],
  );
  const open = useCallback(() => {
    tap();
    setMenu(true);
  }, []);
  const pan = usePanGesture({
    minDistance: 6,
    maxPointers: 1,
    onBegin: () => {
      "worklet";
      cancelAnimation(fade);
      fade.set(1);
    },
    onActivate: () => {
      "worklet";
      cancelAnimation(x);
      cancelAnimation(y);
      fromX.set(x.get());
      fromY.set(y.get());
    },
    onUpdate: (event) => {
      "worklet";
      x.set(Math.max(0, Math.min(width - SIZE, fromX.get() + event.translationX)));
      y.set(Math.max(0, Math.min(height - SIZE, fromY.get() + event.translationY)));
    },
    onDeactivate: (event) => {
      "worklet";
      if (event.canceled) return;
      scheduleOnRN(settle, x.get(), y.get());
    },
    onFinalize: () => {
      "worklet";
      fade.set(withDelay(duration.slow * 6, withTiming(FADED, { duration: duration.slow, reduceMotion: ReduceMotion.System })));
    },
  });
  const press = useTapGesture({
    maxDistance: 6,
    onDeactivate: (event) => {
      "worklet";
      if (!event.canceled) scheduleOnRN(open);
    },
  });
  const gesture = useCompetingGestures(pan, press);
  const position = useAnimatedStyle(() => ({ opacity: fade.get(), transform: [{ translateX: x.get() }, { translateY: y.get() }] }));
  const choose = (item: Item) => {
    setMenu(false);
    if (item.action === "exit") onExit();
    else onAction(item.action);
  };
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <StatusBar hidden />
      <View pointerEvents="box-none" style={{ position: "absolute", left, top, width, height }}>
        <GestureDetector gesture={gesture}>
          <Animated.View
            accessible
            accessibilityRole="button"
            accessibilityLabel="Handheld controls"
            accessibilityHint="Opens Home, Rotate and Exit handheld. Drag to move."
            onAccessibilityTap={open}
            style={[{ position: "absolute", width: SIZE, height: SIZE, alignItems: "center", justifyContent: "center" }, position]}
          >
            <GlassSurface radius={radius.card} />
            <View style={{ width: space.xxxl, height: space.xxxl, borderRadius: radius.full, borderWidth: 2, borderColor: colors.onMedia2 }} />
          </Animated.View>
        </GestureDetector>
      </View>
      {menu && (
        <View accessibilityViewIsModal style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close handheld menu"
            onPress={() => setMenu(false)}
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
          />
          <View
            style={{
              width: 264,
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: "center",
              padding: space.md,
              borderRadius: radius.sheet,
              borderCurve: "continuous",
              backgroundColor: colors.surface,
              boxShadow: colors.shadowOverlay,
            }}
          >
            {handheldMenu(state, android).map((item) => (
              <Pressable
                key={item.action}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityState={{ disabled: !!item.disabled }}
                disabled={item.disabled}
                onPress={() => choose(item)}
                style={({ pressed }) => [
                  { width: 80, minHeight: 80, alignItems: "center", justifyContent: "center", gap: space.sm, borderRadius: radius.card },
                  pressed && { backgroundColor: colors.hover },
                  pressStyle({ pressed, disabled: item.disabled }),
                ]}
              >
                <Icon icon={item.icon} size={24} tone="ink" />
                <Text numberOfLines={2} style={{ color: colors.ink, fontSize: type.caption1, lineHeight: lineHeight.caption1, textAlign: "center" }}>
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
