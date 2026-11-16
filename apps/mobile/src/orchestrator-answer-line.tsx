import { Text, View } from "react-native";
import { lineHeight, space, type } from "./design-tokens";
import { Mascot } from "./mascot";
import { fonts, useTheme } from "./theme";

/** One line in a task Chat for something autopilot answered: the Pebble, then what it chose, commands in code. */
export function OrchestratorAnswerLine({ summary }: { summary: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`The Orchestrator answered for you: ${summary}`}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs }}
    >
      <Mascot size={16} mood="happy" />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
        {summary.split("`").map((part, index) =>
          index % 2 ? (
            <Text key={index} style={{ fontFamily: fonts.mono, color: colors.ink }}>
              {part}
            </Text>
          ) : (
            part
          ),
        )}
      </Text>
    </View>
  );
}
