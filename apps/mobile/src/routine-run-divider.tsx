import { Text } from "react-native";
import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { mergedRoutineRunText, routineRunText } from "@milagre/shared/routines";
import type { RoutineRunContext } from "@milagre/shared/model";
import { lineHeight, type } from "./design-tokens";
import { useTheme } from "./theme";
import { TranscriptDivider } from "./ui";

/** A heartbeat in the transcript, as on desktop: "Heartbeat · 10:15", or the quiet checks folded into one line. */
export function RoutineRunDivider({ context, merged }: { context: RoutineRunContext; merged?: { count: number; last: RoutineRunContext } }) {
  const { colors } = useTheme();
  const text = merged ? mergedRoutineRunText(merged) : routineRunText(context);
  return (
    <TranscriptDivider label={text} icon={Pulse01Icon}>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
        {text}
      </Text>
    </TranscriptDivider>
  );
}
