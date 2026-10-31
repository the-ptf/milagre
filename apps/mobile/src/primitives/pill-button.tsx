import { ActivityIndicator, Pressable, Text, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { Icon, type IconData } from "../icons";
import { tap } from "./tap";

/** A pill button drawn in React Native, for places that need desktop's ink fill. */
export function PillButton({
  title,
  onPress,
  icon,
  disabled = false,
  secondary = false,
  loading = false,
  tone = "ink",
  style,
}: {
  title: string;
  onPress: () => void;
  icon?: IconData;
  disabled?: boolean;
  secondary?: boolean;
  loading?: boolean;
  tone?: "ink" | "orange";
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        {
          height: 46,
          paddingHorizontal: 18,
          borderRadius: 23,
          borderCurve: "continuous",
          flexDirection: "row",
          gap: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: tone === "orange" ? colors.orangeTint : secondary ? colors.surface : colors.ink,
          borderWidth: secondary ? 1 : 0,
          borderColor: colors.lineStrong,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={tone === "orange" ? colors.orangeInk : secondary ? colors.ink2 : colors.onInk} />
      ) : icon ? (
        <Icon icon={icon} tone={tone === "orange" ? "orangeInk" : secondary ? "ink" : "onInk"} size={18} />
      ) : null}
      <Text style={{ color: tone === "orange" ? colors.orangeInk : secondary ? colors.ink : colors.onInk, fontSize: 15, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}
