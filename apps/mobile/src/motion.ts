import { useReducedMotion as useSystemReducedMotion, withSpring, withTiming, type WithSpringConfig, type WithTimingConfig } from "react-native-reanimated";
import { useTheme } from "./theme";

export function useReducedMotion() {
  const system = useSystemReducedMotion();
  const { motionScale } = useTheme();
  return system || motionScale === 0;
}

export function useMotionScale() {
  return useTheme().motionScale;
}

export function scaledTiming(config: WithTimingConfig & { duration: number }, scale: number): WithTimingConfig {
  "worklet";
  return { ...config, duration: Math.round(config.duration * scale) };
}

export function springTo(target: number, config: WithSpringConfig, scale: number) {
  "worklet";
  if (scale <= 0) return withTiming(target, { duration: 0 });
  if (scale === 1) return withSpring(target, config);
  const next = { ...config };
  if (next.duration !== undefined) next.duration = Math.round(next.duration * scale);
  if (next.stiffness !== undefined) next.stiffness = next.stiffness / (scale * scale);
  if (next.damping !== undefined) next.damping = next.damping / scale;
  return withSpring(target, next);
}
