import { useEffect, useRef, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import Animated, {
  cancelAnimation,
  cubicBezier,
  Easing,
  FadeInLeft,
  FadeInRight,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { IconButton } from "./ui";
import { useTheme } from "./theme";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const TRACK_EASE = cubicBezier(0.23, 1, 0.32, 1);
export const INBOX_LAYOUT = LinearTransition.duration(240).easing(EASE_OUT).reduceMotion(ReduceMotion.System);
const ENTER_RIGHT = FadeInRight.duration(180)
  .easing(EASE_OUT)
  .withInitialValues({ transform: [{ translateX: 40 }] })
  .reduceMotion(ReduceMotion.System);
const ENTER_LEFT = FadeInLeft.duration(180)
  .easing(EASE_OUT)
  .withInitialValues({ transform: [{ translateX: -40 }] })
  .reduceMotion(ReduceMotion.System);
const EXIT = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

export function InboxPage({ pageKey, direction, children }: { pageKey: string; direction: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <Animated.View
      key={pageKey}
      collapsable={false}
      entering={reduced ? undefined : direction > 0 ? ENTER_RIGHT : ENTER_LEFT}
      exiting={reduced ? undefined : EXIT}
      layout={INBOX_LAYOUT}
    >
      {children}
    </Animated.View>
  );
}

export function InboxPager({ index, count, select, label = "message" }: { index: number; count: number; select: (index: number) => void; label?: string }) {
  const { scheme, colors } = useTheme();
  const reduced = useReducedMotion();
  const last = Math.max(0, count - 1);
  const current = Math.min(last, Math.max(0, index));
  const choose = (page: number) => {
    if (count > 1) select(Math.min(last, Math.max(0, page)));
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 1 }}>
      <InboxPagerArrow index={current} direction={-1} label={`Previous ${label}`} disabled={current === 0} onPress={() => choose(current - 1)} />
      <Pressable
        testID="inbox-position-track"
        accessibilityRole="adjustable"
        accessibilityLabel={`${label} position`}
        accessibilityHint="Tap the track to jump to a message, or adjust to move one at a time."
        accessibilityState={{ disabled: count < 2 }}
        accessibilityValue={{ min: 1, max: Math.max(1, count), now: current + 1, text: `${count ? current + 1 : 0} of ${count}` }}
        accessibilityActions={[
          { name: "increment", label: `Next ${label}` },
          { name: "decrement", label: `Previous ${label}` },
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "increment") choose(current + 1);
          if (nativeEvent.actionName === "decrement") choose(current - 1);
        }}
        disabled={count < 2}
        onPress={({ nativeEvent }) => choose(Math.round(Math.min(1, Math.max(0, nativeEvent.locationX / 100)) * last))}
        style={{ width: 100, height: 44, marginHorizontal: 4, justifyContent: "center" }}
      >
        <View pointerEvents="none" style={{ width: 100, height: 5, borderRadius: 3, backgroundColor: scheme === "dark" ? "#ffffff26" : "#00000026" }}>
          <Animated.View
            style={{
              width: 22,
              height: 5,
              borderRadius: 3,
              backgroundColor: scheme === "dark" ? "#fff" : "#000",
              transform: [{ translateX: last ? (current / last) * 78 : 0 }],
              transitionProperty: "transform",
              transitionDuration: reduced ? 0 : 220,
              transitionTimingFunction: TRACK_EASE,
            }}
          />
        </View>
      </Pressable>
      <Text
        testID="inbox-position-count"
        accessibilityLiveRegion="polite"
        style={{ minWidth: 49, color: colors.ink3, fontSize: 11, textAlign: "center", fontVariant: ["tabular-nums"] }}
      >
        {count ? current + 1 : 0} of {count}
      </Text>
      <InboxPagerArrow index={current} direction={1} label={`Next ${label}`} disabled={current >= last} onPress={() => choose(current + 1)} />
    </View>
  );
}

function InboxPagerArrow({
  index,
  direction,
  label,
  disabled,
  onPress,
}: {
  index: number;
  direction: number;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const previous = useRef(index);
  const pulse = useSharedValue(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    const moved = (index - previous.current) * direction > 0;
    previous.current = index;
    if (!moved) return;
    cancelAnimation(pulse);
    pulse.set(0);
    pulse.set(
      withSequence(
        ReduceMotion.Never,
        withTiming(1, { duration: 65, easing: EASE_OUT, reduceMotion: ReduceMotion.Never }),
        withTiming(0, { duration: 75, easing: EASE_OUT, reduceMotion: ReduceMotion.Never }),
      ),
    );
  }, [index, direction, pulse]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.45 + pulse.get() * 0.55,
    transform: [{ translateX: reduced ? 0 : direction * 4 * pulse.get() }, { scale: reduced ? 1 : 1 + 0.3 * pulse.get() }],
  }));
  return (
    <Animated.View style={style}>
      <IconButton label={label} icon={direction < 0 ? ArrowLeft01Icon : ArrowRight01Icon} tone="ink" size={40} disabled={disabled} onPress={onPress} />
    </Animated.View>
  );
}
