import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { lineHeight, radius, type } from "../design-tokens";
import { Icon, type IconData } from "../icons";
import { inkFor, useTheme } from "../theme";

type TagTone = "neutral" | "accent" | "green" | "orange" | "red" | "purple";

export function Tag({
  label,
  tone = "neutral",
  icon,
  dot = false,
  tint,
  square = false,
  accessibilityLabel,
  style,
}: {
  label: string;
  tone?: TagTone;
  icon?: IconData;
  dot?: boolean;
  tint?: string;
  square?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const neutral = tone === "neutral";
  const ink = tint ? colors.ink : neutral ? colors.ink2 : inkFor(colors, tone);
  const mark = neutral ? colors.ink3 : colors[tone];
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel ?? label}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          minHeight: 24,
          paddingHorizontal: 8,
          borderRadius: square ? radius.chip : radius.full,
          borderCurve: "continuous",
          backgroundColor: tint ?? (neutral ? colors.field : colors[`${tone}Tint`]),
        },
        style,
      ]}
    >
      {icon ? (
        <Icon icon={icon} color={tint ? ink : mark} size={12} />
      ) : dot ? (
        <View style={{ width: 6, height: 6, borderRadius: radius.full, backgroundColor: mark }} />
      ) : null}
      <Text numberOfLines={1} style={{ color: ink, fontSize: type.caption1, lineHeight: lineHeight.caption1, fontWeight: "500" }}>
        {label}
      </Text>
    </View>
  );
}
