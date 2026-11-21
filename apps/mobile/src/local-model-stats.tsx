import { Text } from "react-native";
import { turnMetricsParts } from "@milagre/shared/ollama-models";
import type { TurnMetrics } from "@milagre/shared/model";
import { lineHeight, type } from "./design-tokens";
import { useTheme } from "./theme";

/** The last turn's speed on a local model, in one quiet line under the composer (as on desktop). */
export function LocalModelStats({ metrics }: { metrics: TurnMetrics | undefined }) {
  const { colors } = useTheme();
  const parts = turnMetricsParts(metrics);
  if (!parts.length) return null;
  return (
    <Text
      accessibilityLabel={`Last turn on this computer: ${parts.map((part) => `${part.label} ${part.text}`).join(", ")}`}
      style={{ fontSize: type.caption2, lineHeight: lineHeight.caption2, color: colors.ink3, paddingHorizontal: 12, fontVariant: ["tabular-nums"] }}
    >
      {parts.map((part) => part.text).join("  ·  ")}
    </Text>
  );
}
