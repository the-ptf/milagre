import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { lineHeight, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { Mascot } from "./mascot";
import { fonts, useTheme } from "./theme";

function Summary({ text, lines }: { text: string; lines?: number }) {
  const { colors } = useTheme();
  return (
    <Text numberOfLines={lines} style={{ flex: 1, color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
      {text.split("`").map((part, index) =>
        index % 2 ? (
          <Text key={index} style={{ fontFamily: fonts.mono, color: colors.ink }}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

/** What autopilot answered in a task Chat, after the Pebble: one line, or a count that opens the list when it answered several in a row. */
export function OrchestratorAnswerLine({ summaries }: { summaries: readonly string[] }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const row = { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs } as const;
  if (summaries.length < 2)
    return (
      <View accessible accessibilityLabel={`The Orchestrator answered for you: ${summaries[0] ?? ""}`} style={row}>
        <Mascot size={16} mood="happy" />
        <Summary text={summaries[0] ?? ""} lines={1} />
      </View>
    );
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={row}>
        <Mascot size={16} mood="happy" />
        <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>Answered {summaries.length} for you</Text>
        <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
      </Pressable>
      {open ? (
        <View style={{ gap: space.xs, marginLeft: space.md, paddingLeft: space.md, borderLeftWidth: 1, borderLeftColor: colors.line }}>
          {summaries.map((summary, index) => (
            <Summary key={index} text={summary} lines={2} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
