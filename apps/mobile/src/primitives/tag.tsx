import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { lineHeight, radius, type } from "../design-tokens";
import { Icon, type IconData } from "../icons";
import { inkFor, useTheme } from "../theme";

type TagTone = "neutral" | "accent" | "green" | "orange" | "red" | "purple";

/**
 * A static label (a state, a setting, a badge): 24pt tall, caption1 12/16 medium, with an optional 12pt icon or 6pt dot.
 * `neutral` is a field fill with an ink2 label (Recommended, Default, a skill's source); a status tone is its tint with
 * its -ink label and a dot in the fill colour. `tint` paints a data colour (a GitHub label) behind an ink label;
 * `square` takes chip corners (6) instead of a pill. It sizes to its label in a row; in a column pass
 * `style={{ alignSelf: "flex-start" }}`. A tappable one is a `Chip`.
 */
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
