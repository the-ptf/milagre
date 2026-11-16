import type { ViewStyle } from "react-native";

export const PRESSED_OPACITY = 0.6;
export const DISABLED_OPACITY = { control: 0.4, row: 0.6 } as const;

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
