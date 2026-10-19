import { useMemo } from "react";
import { useReducedMotion as useSystemReducedMotion, withSpring, withTiming, type WithSpringConfig, type WithTimingConfig } from "react-native-reanimated";
import { useTheme } from "./theme";

/** True when the system asks for reduced motion or Settings > Appearance > Animations is Off. */
export function useReducedMotion() {
  const system = useSystemReducedMotion();
  const { motionScale } = useTheme();
  return system || motionScale === 0;
}

/** Animations setting as a duration multiplier: 1 Normal, 0.6 Fast, 0 Off. */
export function useMotionScale() {
  return useTheme().motionScale;
}

/** A timing config with its duration scaled; Off makes it land at once. Safe in worklets (pass the scale from the hook). */
export function scaledTiming(config: WithTimingConfig & { duration: number }, scale: number): WithTimingConfig {
  "worklet";
  return { ...config, duration: Math.round(config.duration * scale) };
}

/** A spring that is faster at Fast and a plain instant timing at Off. Safe in worklets. */
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

/** Layout/entering presets are built once per scale, not once per render. */
export function useScaledPreset<T>(make: (scale: number) => T): T {
  const scale = useMotionScale();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => make(scale), [scale]);
}
