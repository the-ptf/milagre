import { useRef, useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useMotionScale, useReducedMotion } from "./motion";
import { SEND_LAUNCH_MS, claimSendLaunch, launchOffset, type Point } from "./send-launch-store";

const LAUNCH_EASE = Easing.bezier(0.2, 0.8, 0.2, 1);

export function SendLaunch({ clientMessageId, style: base, children }: { clientMessageId?: string | null; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const reduced = useReducedMotion();
  const scale = useMotionScale();
  const [launch] = useState(() => claimSendLaunch(clientMessageId));
  const box = useRef<ViewInstance>(null);
  const started = useRef(false);
  const offset = useSharedValue<Point>({ x: 0, y: 0 });
  const progress = useSharedValue(launch && !reduced ? 0 : 1);
  const hidden = useSharedValue(launch && !reduced ? 1 : 0);
  const style = useAnimatedStyle(() => ({
    opacity: hidden.value ? 0 : 1,
    transform: [{ translateX: offset.value.x * (1 - progress.value) }, { translateY: offset.value.y * (1 - progress.value) }],
  }));
  const start = () => {
    if (!launch || reduced || started.current) return;
    started.current = true;
    void launch.then((from) => {
      const view = box.current;
      if (!from || !view) {
        hidden.value = 0;
        progress.value = 1;
        return;
      }
      view.measureInWindow((x: number, y: number) => {
        offset.value = launchOffset(from, { x, y });
        hidden.value = 0;
        progress.value = withTiming(1, { duration: Math.round(SEND_LAUNCH_MS * scale), easing: LAUNCH_EASE });
      });
    });
  };
  if (!launch || reduced) return <View style={base}>{children}</View>;
  return (
    <Animated.View ref={box} collapsable={false} onLayout={start} style={[base, style]}>
      {children}
    </Animated.View>
  );
}
