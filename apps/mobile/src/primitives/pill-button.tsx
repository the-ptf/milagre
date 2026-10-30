import { ActivityIndicator, Pressable, Text, type StyleProp, type ViewStyle } from "react-native";
import { radius, type } from "../design-tokens";
import { useTheme } from "../theme";
import { Icon, type IconData } from "../icons";
import { tap } from "./tap";
import { pressStyle } from "./press-style";

/** Heights per size, set as `minHeight` so Dynamic Type can grow the pill: 32 inline/compact, 44 default, 52 a sheet's main action. */
const SIZES = {
  small: { minHeight: 32, paddingHorizontal: 12, gap: 6, fontSize: type.footnote, icon: 16 },
  regular: { minHeight: 44, paddingHorizontal: 16, gap: 8, fontSize: type.subheadline, icon: 18 },
  large: { minHeight: 52, paddingHorizontal: 20, gap: 8, fontSize: type.body, icon: 20 },
} as const;

/** The primary action: ink fill, onInk label (`secondary` draws it on the surface with a border). */
export function PillButton({
  title,
  onPress,
  icon,
  disabled = false,
  secondary = false,
  loading = false,
  size = "regular",
  style,
}: {
  title: string;
  onPress: () => void;
  icon?: IconData;
  disabled?: boolean;
  secondary?: boolean;
  loading?: boolean;
  size?: keyof typeof SIZES;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const metrics = SIZES[size];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, busy: loading }}
      // A small pill still takes a 44pt touch.
      hitSlop={size === "small" ? 6 : undefined}
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        {
          minHeight: metrics.minHeight,
          paddingHorizontal: metrics.paddingHorizontal,
          borderRadius: radius.full,
          borderCurve: "continuous",
          flexDirection: "row",
          gap: metrics.gap,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: secondary ? colors.surface : colors.ink,
          borderWidth: secondary ? 1 : 0,
          borderColor: colors.lineStrong,
        },
        pressStyle({ pressed, disabled, filled: !secondary }),
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={secondary ? colors.ink2 : colors.onInk} />
      ) : icon ? (
        <Icon icon={icon} tone={secondary ? "ink" : "onInk"} size={metrics.icon} />
      ) : null}
      <Text style={{ color: secondary ? colors.ink : colors.onInk, fontSize: metrics.fontSize, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}
