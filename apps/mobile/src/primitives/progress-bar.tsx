import { View } from "react-native";
import { radius } from "../design-tokens";
import { useTheme } from "../theme";

/**
 * A progress or usage bar, as desktop's ProgressBar: a lineStrong track with an ink fill (or a state tone at usage
 * thresholds), full radius, 4 or 6 tall. `value` is 0 to 1; it reads as a progress bar with its percentage, or with
 * `valueText` ("42% used, 84k tokens") when given.
 */
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
