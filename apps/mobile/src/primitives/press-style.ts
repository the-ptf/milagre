import type { ViewStyle } from "react-native";

/** Press opacity on every pressable (system.md, States). */
export const PRESSED_OPACITY = 0.6;
/** Disabled opacity: controls fade to 40%, list rows to 60%. */
export const DISABLED_OPACITY = { control: 0.4, row: 0.6 } as const;

/**
 * The press and disabled look for a Pressable's `style` callback: opacity 0.6 when pressed, plus scale 0.97 on a filled
 * button; disabled 0.4 on controls, 0.6 on rows. `style={({ pressed }) => [base, pressStyle({ pressed, disabled })]}`.
 */
export function pressStyle({
  pressed,
  disabled = false,
  filled = false,
  kind = "control",
}: {
  pressed: boolean;
  disabled?: boolean;
  filled?: boolean;
  kind?: keyof typeof DISABLED_OPACITY;
}): ViewStyle {
  if (disabled) return { opacity: DISABLED_OPACITY[kind] };
  if (!pressed) return { opacity: 1 };
  return filled ? { opacity: PRESSED_OPACITY, transform: [{ scale: 0.97 }] } : { opacity: PRESSED_OPACITY };
}
