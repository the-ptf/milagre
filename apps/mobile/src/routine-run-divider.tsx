import { Text, View } from "react-native";
import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { mergedRoutineRunText, routineRunText } from "@milagre/shared/routines";
import type { RoutineRunContext } from "@milagre/shared/model";
import { Icon } from "./icons";
import { useTheme } from "./theme";

/** A heartbeat in the transcript, as on desktop: "Heartbeat · 10:15", or the quiet checks folded into one line. */
export function RoutineRunDivider({ context, merged }: { context: RoutineRunContext; merged?: { count: number; last: RoutineRunContext } }) {
  const { colors } = useTheme();
  const text = merged ? mergedRoutineRunText(merged) : routineRunText(context);
  return (
    <View accessible accessibilityLabel={text} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <View style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 }}>
        <Icon icon={Pulse01Icon} tone="ink3" size={13} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink3, fontSize: 12 }}>
          {text}
        </Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}
