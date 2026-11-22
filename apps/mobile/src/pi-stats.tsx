import { useState } from "react";
import { Text } from "react-native";
import { piStatsParts } from "@milagre/shared/pi-models";
import type { ContextUsage } from "@milagre/shared/model";
import { lineHeight, type } from "./design-tokens";
import { useTheme } from "./theme";

/** One faint, centred line under a Pi Chat's composer: a local model's last turn, and what the Chat has spent on paid
 * models. A tap shows it clearly, as hover does on desktop. */
export function PiStats({ usage, local }: { usage: ContextUsage | undefined; local: boolean }) {
  const { colors } = useTheme();
  const [shown, setShown] = useState(false);
  const parts = piStatsParts(usage, { local });
  if (!parts.length) return null;
  return (
    <Text
      onPress={() => setShown((value) => !value)}
      accessibilityRole="button"
      accessibilityHint="Shows the numbers clearly"
      accessibilityLabel={`${local ? "Last turn on this computer" : "This Chat on Pi"}: ${parts.map((part) => `${part.label} ${part.text}`).join(", ")}`}
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
