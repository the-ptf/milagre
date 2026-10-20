import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { useMotionScale, springTo } from "./motion";
import { useTheme } from "./theme";

const HEIGHT = 32;
const HANDLE = 4;
const INSET = 12;
const SPRING = { damping: 18, stiffness: 260, mass: 0.6, reduceMotion: ReduceMotion.System };

/** The model sheet's thinking-effort slider: one stop per level, a bar handle that springs between them, drag anywhere
 * or tap a stop. Each new level ticks a selection haptic; VoiceOver steps it with swipe up and down. */
export function EffortSlider({
  index,
  count,
  label,
  valueText,
  onChange,
}: {
  index: number;
  count: number;
  label: string;
  valueText: string;
  onChange: (index: number) => void;
}) {
  const { colors } = useTheme();
  const scale = useMotionScale();
  const [width, setWidth] = useState(0);
  const span = Math.max(1, width - INSET * 2);
  const steps = Math.max(1, count - 1);
  const x = useSharedValue(0);
  const last = useSharedValue(index);

  useEffect(() => {
    last.set(index);
    x.set(width ? springTo(INSET + (span * index) / steps, SPRING, scale) : 0);
  }, [index, width, span, steps, x, last, scale]);

  const pick = (next: number) => {
    if (Platform.OS === "ios") void Haptics.selectionAsync().catch(() => {});
    onChange(next);
  };
  const gesture = sliderGesture({ x, last, span, steps, pick, scale });
  const fill = useAnimatedStyle(() => ({ width: x.get() + HANDLE }));
  const handle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() - HANDLE / 2 }] }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: valueText }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => {
          const next = index + (event.nativeEvent.actionName === "increment" ? 1 : -1);
          if (next >= 0 && next < count) pick(next);
        }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={{ height: HEIGHT, borderRadius: 10, borderCurve: "continuous", backgroundColor: colors.field, overflow: "hidden", justifyContent: "center" }}
      >
        <Animated.View style={[{ position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: colors.ink, opacity: 0.12 }, fill]} />
        {width > 0 &&
          Array.from({ length: count }, (_, stop) => (
            <View
              key={stop}
              style={{
                position: "absolute",
                left: INSET + (span * stop) / steps - 2,
                width: 4,
                height: 4,
                borderRadius: 2,
                backgroundColor: colors.ink3,
                opacity: 0.6,
              }}
            />
          ))}
        <Animated.View style={[{ position: "absolute", left: 0, width: HANDLE, height: 20, borderRadius: 2, backgroundColor: colors.ink }, handle]} />
      </View>
    </GestureDetector>
  );
}

/** Drag anywhere or tap a stop; the handle follows the finger and springs to the nearest stop on release. */
function sliderGesture({
  x,
  last,
  span,
  steps,
  pick,
  scale,
}: {
  x: SharedValue<number>;
  last: SharedValue<number>;
  span: number;
  steps: number;
  pick: (index: number) => void;
  scale: number;
}) {
  const toIndex = (position: number) => {
    "worklet";
    return Math.min(steps, Math.max(0, Math.round(((position - INSET) / span) * steps)));
  };
  const land = (position: number) => {
    "worklet";
    const next = toIndex(position);
    if (next !== last.get()) {
      last.set(next);
      scheduleOnRN(pick, next);
    }
  };
  return Gesture.Race(
    Gesture.Pan()
      .minDistance(2)
      .onUpdate((event) => {
        x.set(Math.min(INSET + span, Math.max(INSET, event.x)));
        land(event.x);
      })
      .onEnd(() => {
        x.set(springTo(INSET + (span * last.get()) / steps, SPRING, scale));
      }),
    Gesture.Tap().onEnd((event) => {
      land(event.x);
      x.set(springTo(INSET + (span * toIndex(event.x)) / steps, SPRING, scale));
    }),
  );
}
