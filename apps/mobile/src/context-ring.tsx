import { Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { ContextUsage } from "@milagre/shared/model";
import { contextSummary, contextTone } from "@milagre/shared/usage";
import { hitSlopFor, radius as corner } from "./design-tokens";
import { useTheme } from "./theme";
import { pressStyle } from "./ui";

/** A ring that fills as the agent's context window does; the agent compacts it when it gets close to full. A tap opens the details. */
export function ContextRing({ onPress, canCompact = false, ...usage }: ContextUsage & { onPress: () => void; canCompact?: boolean }) {
  const { colors } = useTheme();
  const { ratio, percent, tokens } = contextSummary(usage);
  const tone = contextTone(percent);
  // Getting full is a warning (orange), not a link or a selection.
  const color = { normal: colors.ink2, warning: colors.orange, critical: colors.red }[tone];
  const attention = canCompact && tone !== "normal";
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Context: ${percent}% used (${tokens})`}
      accessibilityHint={attention ? "Compaction recommended. Open context details to compact." : undefined}
      onPress={onPress}
      hitSlop={hitSlopFor(32)}
      style={({ pressed }) => [{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }, pressStyle({ pressed })]}
    >
      <Svg width={20} height={20} viewBox="0 0 20 20" style={{ transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={10} cy={10} r={radius} fill="none" stroke={colors.lineStrong} strokeWidth={2.5} />
        <Circle
          cx={10}
          cy={10}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </Svg>
      {attention && (
        <View
          accessible={false}
          pointerEvents="none"
          style={{
            position: "absolute",
            right: 2,
            top: 2,
            width: 8,
            height: 8,
            borderRadius: corner.full,
            backgroundColor: color,
            borderWidth: 1.5,
            borderColor: colors.surface,
          }}
        />
      )}
    </Pressable>
  );
}
