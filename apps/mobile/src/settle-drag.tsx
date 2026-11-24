import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { ReduceMotion, interpolate, useAnimatedStyle, useSharedValue, Extrapolation } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { AlarmClockIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./icons";
import { springTo, useMotionScale } from "./motion";
import { duration, lineHeight, radius, space, type } from "./design-tokens";
import { ComposerGlass } from "./composer-glass";
import { snoozeDurationLabel } from "@milagre/shared/snooze";
import { useSnoozeMinutes } from "./snooze-setting";
import { useTheme } from "./theme";
import { tap } from "./primitives/tap";
import { useSettleFlight } from "./settle-flight";

export type SettleActions = { done: (arrived?: Promise<void>) => Promise<boolean>; snooze: (until: number) => void };

const OPEN = 100;
const OPEN_AT = 36;
const RAISE = 0.6;
const MAX = 160;
const FLICK = -500;
const HALF = 52;
const SETTLE = 0;
const SNOOZE = 1;
const SPRING = { duration: duration.slow, dampingRatio: 0.9, overshootClamping: true, reduceMotion: ReduceMotion.System };
const MINUTE = 60 * 1000;

function Half({
  icon,
  label,
  index,
  chosen,
  onPress,
}: {
  icon: typeof Tick02Icon;
  label: string;
  index: number;
  chosen: { get(): number };
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const fill = useAnimatedStyle(() => ({ opacity: chosen.get() === index ? 1 : 0 }));
  const content = (color: string) => (
    <>
      <Icon icon={icon} size={20} color={color} />
      <Text style={{ color, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600" }}>{label}</Text>
    </>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ flex: 1, height: HALF, borderRadius: radius.full, boxShadow: colors.shadowRaised }}
    >
      <ComposerGlass radius={radius.full} />
      <Animated.View style={[styles.half, { backgroundColor: colors.ink }, fill]} />
      <View style={styles.row}>{content(colors.ink)}</View>
      <Animated.View style={[styles.row, fill]}>{content(colors.onInk)}</Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  half: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderRadius: radius.full },
  row: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.md },
});

/** Done from within: swipe the composer up and Done and Snooze stay open under it. Tap one, or flick up again to
 * mark it Done; swipe down to close. Mark Done stays in the ⋯ menu for VoiceOver and for anyone who doesn't swipe. */
export function SettleDrag({ actions, children }: { actions?: SettleActions; children: ReactNode }) {
  const scale = useMotionScale();
  const [minutes] = useSnoozeMinutes();
  const flight = useSettleFlight();
  const [open, setOpen] = useState(false);
  const lift = useSharedValue(0);
  const base = useSharedValue(0);
  const chosen = useSharedValue(SETTLE);
  const width = useSharedValue(0);
  const rest = useCallback(
    (to: number) => {
      lift.set(springTo(to, SPRING, scale));
      base.set(to);
      setOpen(to > 0);
    },
    [lift, base, scale],
  );
  const commit = useCallback(
    (choice: number) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      rest(0);
      if (choice === SNOOZE) actions?.snooze(Date.now() + minutes * MINUTE);
      else if (actions && flight) flight(actions.done);
      else void actions?.done();
    },
    [actions, flight, minutes, rest],
  );
  const enabled = !!actions;
  useEffect(() => {
    if (enabled) return;
    lift.set(0);
    base.set(0);
  }, [enabled, lift, base]);
  const pan = usePanGesture({
    enabled: !!actions,
    maxPointers: 1,
    activeOffsetY: [-12, 12],
    failOffsetX: [-28, 28],
    onActivate: () => {
      "worklet";
      if (base.get() === 0) chosen.set(SETTLE);
    },
    onUpdate: (event) => {
      "worklet";
      const up = Math.max(0, base.get() - event.translationY);
      lift.set(up > MAX ? MAX + (up - MAX) * 0.2 : up);
      if (base.get() > 0 || up < OPEN_AT) return;
      const next = event.x > width.get() / 2 + 24 ? SNOOZE : SETTLE;
      if (next !== chosen.get()) scheduleOnRN(tap);
      chosen.set(next);
    },
    onDeactivate: (event) => {
      "worklet";
      if (event.canceled) return;
      if (base.get() > 0 && event.velocityY < FLICK) scheduleOnRN(commit, chosen.get());
      else scheduleOnRN(rest, lift.get() >= OPEN_AT && event.velocityY < -FLICK ? OPEN : 0);
    },
    onFinalize: (event) => {
      "worklet";
      if (event.canceled) lift.set(springTo(base.get(), SPRING, scale));
    },
  });
  const raised = useAnimatedStyle(() => ({ transform: [{ translateY: -lift.get() * RAISE }] }));
  const tray = useAnimatedStyle(() => ({
    opacity: interpolate(lift.get(), [8, OPEN * 0.6], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(lift.get(), [0, OPEN], [16, 0], Extrapolation.CLAMP) }],
  }));
  if (!actions) return <>{children}</>;
  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false} onLayout={({ nativeEvent }) => width.set(nativeEvent.layout.width)}>
        <Animated.View
          pointerEvents={open ? "box-none" : "none"}
          style={[
            {
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              flexDirection: "row",
              gap: space.md,
            },
            tray,
          ]}
        >
          <Half icon={Tick02Icon} label="Done" index={SETTLE} chosen={chosen} onPress={() => commit(SETTLE)} />
          <Half icon={AlarmClockIcon} label={`Snooze ${snoozeDurationLabel(minutes)}`} index={SNOOZE} chosen={chosen} onPress={() => commit(SNOOZE)} />
        </Animated.View>
        <Animated.View style={raised}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}
