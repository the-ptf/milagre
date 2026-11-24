import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions, type StyleProp, type TextStyle, type ViewProps } from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { router } from "expo-router";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./icons";
import { scaledTiming, useMotionScale } from "./motion";
import { duration, easing, radius } from "./design-tokens";
import { useTheme } from "./theme";

export { markChatDone, settleActions } from "./chat-done";

type Fly = (land: (arrived: Promise<void>) => Promise<boolean>) => void;

const LIFT = 260;
const AWAY = 480;
const AWAY_AT = 380;
const ARRIVE_IN = 160;
const PULSE_MS = 1400;
const enter = Easing.bezier(...easing.enter);
const slide = Easing.bezier(...easing.slide);

/** Leaving a settled Chat: its route clears, and a phone shows the Chat list it went to. */
export function leaveToList(dockable: boolean, showList: () => void) {
  router.setParams({ id: undefined, worktreeId: undefined, draft: undefined, prefill: undefined });
  if (!dockable) showList();
}

const FlightContext = createContext<Fly | null>(null);
export const useSettleFlight = () => useContext(FlightContext);

let settledAt = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Done from within (design C): the Chat lifts into a card under a green check, then flies off toward the list, and
 * only then is it marked Done. The list's Done count flashes green when it lands. */
export function SettleFlight({ children, style, ...view }: ViewProps & { children: ReactNode }) {
  const { colors } = useTheme();
  const scale = useMotionScale();
  const { width } = useWindowDimensions();
  const lift = useSharedValue(0);
  const away = useSharedValue(0);
  const arrive = useRef<(() => void) | null>(null);
  const reset = useCallback(
    (ok: boolean) => {
      lift.set(0);
      away.set(0);
      if (!ok) return;
      settledAt = Date.now();
      listeners.forEach((listener) => listener());
    },
    [lift, away],
  );
  const finish = useCallback(() => {
    arrive.current?.();
    arrive.current = null;
  }, []);
  const fly = useCallback<Fly>(
    (land) => {
      void land(new Promise<void>((resolve) => (arrive.current = resolve))).then(reset, () => reset(false));
      setTimeout(finish, Math.round((AWAY_AT + ARRIVE_IN) * scale));
      lift.set(withTiming(1, scaledTiming({ duration: LIFT, easing: enter }, scale)));
      away.set(
        withDelay(
          Math.round(AWAY_AT * scale),
          withTiming(1, scaledTiming({ duration: AWAY, easing: slide }, scale), () => scheduleOnRN(finish)),
        ),
      );
    },
    [lift, away, scale, finish, reset],
  );
  const card = useAnimatedStyle(() => ({
    borderRadius: interpolate(lift.get(), [0, 1], [0, 44]),
    opacity: interpolate(away.get(), [0.2, 1], [1, 0], Extrapolation.CLAMP),
    transform: [
      { translateX: interpolate(away.get(), [0, 1], [0, -width * 0.3]) },
      { translateY: interpolate(away.get(), [0, 1], [0, -130]) },
      { scale: interpolate(lift.get(), [0, 1], [1, 0.9]) * interpolate(away.get(), [0, 1], [1, 0.1]) },
    ],
  }));
  const stamp = useAnimatedStyle(() => ({ opacity: lift.get(), transform: [{ scale: interpolate(lift.get(), [0, 1], [0.4, 1]) }] }));
  return (
    <View {...view} style={[style, { backgroundColor: colors.page }]}>
      <FlightContext.Provider value={fly}>
        <Animated.View style={[styles.card, { backgroundColor: colors.page, boxShadow: colors.shadowRaised }, card]}>
          {children}
          <Animated.View pointerEvents="none" style={[styles.stamp, { backgroundColor: colors.green }, stamp]}>
            <View style={{ transform: [{ scale: 2 }] }}>
              <Icon icon={Tick02Icon} size={24} color={colors.page} />
            </View>
          </Animated.View>
        </Animated.View>
      </FlightContext.Provider>
    </View>
  );
}

/** A Done count that flashes green right after a Chat lands in Done. */
export function SettledCount({ count, style }: { count: number; style?: StyleProp<TextStyle> }) {
  const { colors } = useTheme();
  const scale = useMotionScale();
  const at = useSyncExternalStore(subscribe, () => settledAt);
  const glow = useSharedValue(0);
  useEffect(() => {
    if (!at || Date.now() - at > PULSE_MS) return;
    glow.set(1);
    glow.set(withDelay(Math.round(duration.slow * scale), withTiming(0, scaledTiming({ duration: PULSE_MS, easing: enter }, scale))));
  }, [at, glow, scale]);
  const tint = useAnimatedStyle(() => ({ color: interpolateColor(glow.get(), [0, 1], [colors.ink3, colors.green]) }));
  return <Animated.Text style={[style, { fontVariant: ["tabular-nums"] }, tint]}>{count}</Animated.Text>;
}

const styles = StyleSheet.create({
  card: { flex: 1, overflow: "hidden", borderCurve: "continuous" },
  stamp: {
    position: "absolute",
    alignSelf: "center",
    top: "50%",
    width: 96,
    height: 96,
    marginTop: -48,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
});
