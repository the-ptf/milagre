import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { radius } from "./design-tokens";
import { useMotionScale, useReducedMotion } from "./motion";
import { useTheme } from "./theme";

const BAND = 0.4;

function Band({ color, width }: { color: string; width: number }) {
  const reduced = useReducedMotion();
  const scale = useMotionScale();
  const offset = useSharedValue(reduced ? 0.3 : -BAND);
  useEffect(() => {
    if (reduced) {
      offset.set(0.3);
      return;
    }
    offset.set(-BAND);
    offset.set(withRepeat(withTiming(1, { duration: Math.round(1300 * scale), easing: Easing.bezier(0.4, 0, 0.2, 1) }), -1, false));
    return () => cancelAnimation(offset);
  }, [reduced, scale, offset]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() * width }] }));
  return <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, width: width * BAND, borderRadius: radius.full, backgroundColor: color }, style]} />;
}

/** A ProgressBar's track for work with no measurable progress: a band sweeps it instead of filling it. */
export function ProgressSweep({ size = 6, accessibilityLabel, valueText }: { size?: 4 | 6; accessibilityLabel?: string; valueText?: string }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={valueText ? { text: valueText } : undefined}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ height: size, borderRadius: radius.full, backgroundColor: colors.lineStrong, overflow: "hidden" }}
    >
      {width > 0 && <Band color={colors.ink} width={width} />}
    </View>
  );
}
