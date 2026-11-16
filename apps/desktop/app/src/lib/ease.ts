import { useReducedMotion } from "motion/react";
import { MOTION_SPEEDS } from "@milagre/shared/appearance";
import { useSettings } from "./settings";

// Motion tokens for motion/react, the JS side of styles.css's --duration-* and --ease-* (DESIGN.md).
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const DURATION = { fast: 0.12, base: 0.18, slow: 0.28 } as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;
export const SPRING_SWAP = {
  type: "spring",
  stiffness: 460,
  damping: 30,
  mass: 0.55,
} as const;
export const SPRING_GLIDE = {
  type: "spring",
  stiffness: 400,
  damping: 28,
  mass: 0.5,
} as const;

export function useMotionScale(): number {
  const reduced = useReducedMotion();
  const { appearance } = useSettings();
  return reduced ? 0 : (MOTION_SPEEDS.find((speed) => speed.id === appearance.motion)?.scale ?? 1);
}

export function scaled(seconds: number, scale: number): number {
  return seconds * scale;
}

export function scaledSpring<T extends { stiffness: number; damping: number }>(spring: T, scale: number): T | { duration: 0 } {
  if (scale === 1) return spring;
  if (scale <= 0) return { duration: 0 };
  return { ...spring, stiffness: spring.stiffness / (scale * scale), damping: spring.damping / scale };
}
