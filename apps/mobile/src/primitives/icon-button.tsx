import { ActivityIndicator, Pressable } from "react-native";
import { useTheme } from "../theme";
import { Icon, type IconData, type Tone } from "../icons";
import { tap } from "./tap";

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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}
      hitSlop={4}
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: filled ? colors.ink : "transparent",
        opacity: disabled ? 0.35 : pressed ? 0.5 : 1,
      })}
    >
      {loading ? <ActivityIndicator color={filled ? colors.onInk : colors.ink2} /> : <Icon icon={icon} size={20} tone={filled ? "onInk" : tone} />}
    </Pressable>
  );
}
