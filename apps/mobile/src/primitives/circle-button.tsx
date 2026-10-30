import { Pressable, StyleSheet, View } from "react-native";
import { hitSlopFor, radius } from "../design-tokens";
import { useTheme } from "../theme";
import { Icon, type IconData } from "../icons";
import { tap } from "./tap";
import { pressStyle } from "./press-style";

/**
 * The round bordered buttons inside sheets (close, back, done). `filled` is the primary: ink fill, onInk icon.
 * `disabled` (or no `onPress`) keeps the button role and label, dims it to 40% and reads as dimmed.
 */
export function CircleButton({
  label,
  icon,
  onPress,
  filled = false,
  disabled = false,
}: {
  label: string;
  icon: IconData;
  onPress?: () => void;
  filled?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const off = disabled || !onPress;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off }}
      hitSlop={hitSlopFor(40)}
      disabled={off}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => pressStyle({ pressed, disabled: off, filled })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.full,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: filled ? colors.ink : colors.surface,
          borderWidth: filled ? 0 : StyleSheet.hairlineWidth,
          borderColor: colors.lineStrong,
        }}
      >
        <Icon icon={icon} size={20} tone={filled ? "onInk" : "ink"} />
      </View>
    </Pressable>
  );
}
