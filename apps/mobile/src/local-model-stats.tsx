import { useState } from "react";
import { Text } from "react-native";
import { turnMetricsParts } from "@milagre/shared/ollama-models";
import type { TurnMetrics } from "@milagre/shared/model";
import { lineHeight, type } from "./design-tokens";
import { useTheme } from "./theme";

/** The last turn's speed on a local model, in one faint, centred line under the composer. A tap shows it clearly, as hover does on desktop. */
export function LocalModelStats({ metrics }: { metrics: TurnMetrics | undefined }) {
  const { colors } = useTheme();
  const [shown, setShown] = useState(false);
  const parts = turnMetricsParts(metrics);
  if (!parts.length) return null;
  return (
    <Text
      onPress={() => setShown((value) => !value)}
      accessibilityRole="button"
      accessibilityHint="Shows the numbers clearly"
      accessibilityLabel={`Last turn on this computer: ${parts.map((part) => `${part.label} ${part.text}`).join(", ")}`}
      style={{
        fontSize: type.caption2,
        lineHeight: lineHeight.caption2,
        color: shown ? colors.ink3 : colors.lineStrong,
        textAlign: "center",
        paddingHorizontal: 12,
        fontVariant: ["tabular-nums"],
      }}
    >
      {parts.map((part) => part.text).join("  ·  ")}
    </Text>
  );
}
