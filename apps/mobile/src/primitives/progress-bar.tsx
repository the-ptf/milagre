import { View } from "react-native";
import { radius } from "../design-tokens";
import { useTheme } from "../theme";

export function ProgressBar({
  value,
  tone = "ink",
  size = 6,
  accessibilityLabel,
  valueText,
}: {
  value: number;
  tone?: "ink" | "green" | "orange" | "red";
  size?: 4 | 6;
  accessibilityLabel?: string;
  valueText?: string;
}) {
  const { colors } = useTheme();
  const now = Math.round(Math.min(1, Math.max(0, value || 0)) * 100);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now, ...(valueText ? { text: valueText } : {}) }}
      style={{ height: size, borderRadius: radius.full, backgroundColor: colors.lineStrong, overflow: "hidden" }}
    >
      <View style={{ width: `${now}%`, height: "100%", borderRadius: radius.full, backgroundColor: colors[tone] }} />
    </View>
  );
}
