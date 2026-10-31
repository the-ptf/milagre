import { Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { ContextUsage } from "@milagre/shared/model";
import { contextSummary } from "@milagre/shared/usage";
import { useTheme } from "./theme";
import { Icon } from "./icons";

/** A ring that fills as the agent's context window does, orange past the compact threshold. A tap opens the details. */
export function ContextRing({
  onPress,
  canCompact = false,
  showSize = true,
  threshold = 70,
  ...usage
}: ContextUsage & { onPress: () => void; canCompact?: boolean; showSize?: boolean; threshold?: number }) {
  const { colors } = useTheme();
  const { ratio, percent, tokens } = contextSummary(usage);
  const attention = canCompact && percent >= threshold;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Context: ${percent}% used (${tokens})`}
      onPress={onPress}
      hitSlop={5}
      style={({ pressed }) => ({ width: 34, height: 34, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}
    >
      {showSize ? (
        <Svg width={20} height={20} viewBox="0 0 20 20" style={{ transform: [{ rotate: "-90deg" }] }}>
          <Circle cx={10} cy={10} r={radius} fill="none" stroke={colors.lineStrong} strokeWidth={2.5} />
          <Circle
            cx={10}
            cy={10}
            r={radius}
            fill="none"
            stroke={attention ? colors.orangeInk : colors.ink2}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
          />
        </Svg>
      ) : (
        <View>
          <Icon icon={ArrowDown01Icon} size={12} />
        </View>
      )}
    </Pressable>
  );
}
