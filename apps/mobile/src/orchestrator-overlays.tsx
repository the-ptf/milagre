import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { Easing, FadeInDown, FadeOutDown, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { easing, lineHeight, radius, space, type } from "./design-tokens";
import { Mascot } from "./mascot";
import { scaledTiming, useMotionScale, useReducedMotion } from "./motion";
import { useTheme } from "./theme";
import { pressStyle, useStyles } from "./ui";

const CARRY_MS = 560;
const TOAST_MS = 5000;

/** The prompt you sent, lifted off the box and carried down onto the board, with Pebble riding on top of it. */
export function CarriedNote({ text, from, to, color, onDone }: { text: string; from: number; to: number; color: string; onDone: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const scale = useMotionScale();
  const progress = useSharedValue(0);
  useEffect(() => {
    if (reduced || scale === 0) {
      onDone();
      return;
    }
    progress.set(
      withTiming(1, scaledTiming({ duration: CARRY_MS, easing: Easing.bezier(...easing.slide) }, scale), (finished) => {
        if (finished) runOnJS(onDone)();
      }),
    );
  }, [onDone, progress, reduced, scale]);
  const moving = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.8, 1], [1, 1, 0]),
    transform: [{ translateY: interpolate(progress.value, [0, 0.2, 1], [from, from - 12, to]) }, { scale: interpolate(progress.value, [0, 1], [1, 0.92]) }],
  }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", left: space.gutter, right: space.gutter, top: 0 }, moving]}>
      <View style={{ position: "absolute", top: -20, left: space.xl }}>
        <Mascot size={24} color={color} mood="happy" gaze={{ x: 0, y: 1 }} />
      </View>
      <View style={[styles.card, { paddingVertical: space.lg, boxShadow: colors.shadowRaised, borderWidth: 0 }]}>
        <Text numberOfLines={2} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
          {text}
        </Text>
      </View>
    </Animated.View>
  );
}

function ToastAction({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        { minHeight: 44, minWidth: 44, paddingHorizontal: space.md, alignItems: "center", justifyContent: "center" },
        pressStyle({ pressed }),
      ]}
    >
      <Text style={{ color: colors.onInk, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** "Started in <Project>", with Undo and Open, over the bottom of the board for a few seconds. */
export function StartedToast({
  project,
  color,
  onUndo,
  onOpen,
  onHide,
}: {
  project: string;
  color: string;
  onUndo: () => void;
  onOpen: () => void;
  onHide: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const timer = setTimeout(onHide, TOAST_MS);
    return () => clearTimeout(timer);
  }, [onHide]);
  return (
    <Animated.View
      entering={FadeInDown}
      exiting={FadeOutDown}
      pointerEvents="box-none"
      style={{ position: "absolute", left: space.gutter, right: space.gutter, bottom: Math.max(insets.bottom + space.lg, space.xxl), alignItems: "center" }}
    >
      <View
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          alignSelf: "stretch",
          maxWidth: 420,
          minHeight: 52,
          paddingLeft: space.lg,
          paddingRight: space.xs,
          borderRadius: radius.card,
          borderCurve: "continuous",
          backgroundColor: colors.ink,
          boxShadow: colors.shadowRaised,
        }}
      >
        <Mascot size={24} color={color} mood="happy" />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.onInk, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}>
          Started in {project}
        </Text>
        <ToastAction label="Undo" onPress={onUndo} />
        <ToastAction label="Open" onPress={onOpen} />
      </View>
    </Animated.View>
  );
}
