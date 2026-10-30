import { ActivityIndicator, Pressable } from "react-native";
import { hitSlopFor, radius } from "../design-tokens";
import { useTheme } from "../theme";
import { Icon, type IconData, type Tone } from "../icons";
import { tap } from "./tap";
import { useHover } from "./hover";
import { pressStyle } from "./press-style";

export function IconButton({
  label,
  icon,
  onPress,
  disabled = false,
  filled = false,
  loading = false,
  tone = "ink2",
  size = 36,
}: {
  label: string;
  icon: IconData;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
  loading?: boolean;
  tone?: Tone;
  size?: number;
}) {
  const { colors } = useTheme();
  const { hovered, ...pointer } = useHover();
  return (
    <Pressable
      {...pointer}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}
      hitSlop={hitSlopFor(size)}
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: radius.full,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: filled ? colors.ink : hovered && !disabled ? colors.hover : "transparent",
        },
        pressStyle({ pressed, disabled, filled }),
      ]}
    >
      {loading ? <ActivityIndicator color={filled ? colors.onInk : colors.ink2} /> : <Icon icon={icon} size={20} tone={filled ? "onInk" : tone} />}
    </Pressable>
  );
}
