import { Pressable, Text, View } from "react-native";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { ContextUsage } from "@milagre/shared/model";
import { contextSummary } from "@milagre/shared/usage";
import { useTheme } from "./theme";
import { Icon } from "./icons";

export function ContextRing({
  onPress,
  canCompact = false,
  showSize = true,
  threshold = 70,
  ...usage
}: ContextUsage & { onPress: () => void; canCompact?: boolean; showSize?: boolean; threshold?: number }) {
  const { colors } = useTheme();
  const { percent, tokens } = contextSummary(usage);
  const attention = canCompact && percent >= threshold;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Context: ${percent}% used (${tokens})`}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: 44,
        minHeight: 44,
        paddingHorizontal: 6,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {showSize ? (
        <Text style={{ color: attention ? colors.orangeInk : colors.ink2, fontSize: 13, fontWeight: "500", fontVariant: ["tabular-nums"] }}>{percent}%</Text>
      ) : (
        <View>
          <Icon icon={ArrowDown01Icon} size={12} />
        </View>
      )}
    </Pressable>
  );
}
