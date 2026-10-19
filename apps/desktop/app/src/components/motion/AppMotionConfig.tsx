import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { MOTION_SPEEDS } from "@milagre/shared/appearance";
import { useSettings } from "../../lib/settings";

/**
 * The app root's motion setting. Motion "Off" is reduced motion for every animation underneath, including the ones
 * that never read the scale (layout, LayoutGroup slides); any other speed follows the system preference.
 */
export function AppMotionConfig({ children }: { children: ReactNode }) {
  const { appearance } = useSettings();
  const scale = MOTION_SPEEDS.find((speed) => speed.id === appearance.motion)?.scale ?? 1;
  return <MotionConfig reducedMotion={scale === 0 ? "always" : "user"}>{children}</MotionConfig>;
}
