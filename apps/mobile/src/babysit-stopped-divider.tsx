import { Text, View } from "react-native";
import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { babysitStoppedText } from "@milagre/shared/babysit";
import type { BabysitStoppedContext } from "@milagre/shared/model";
import { Icon } from "./icons";
import { useTheme } from "./theme";

/** Where the Heartbeat babysitting the Chat's PR ended, as on desktop: "Stopped babysitting PR #1: merged." */
export function BabysitStoppedDivider({ context }: { context: BabysitStoppedContext }) {
  const { colors } = useTheme();
  const text = babysitStoppedText(context);
  return (
    <View accessible accessibilityLabel={text} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <View style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 }}>
        <Icon icon={Pulse01Icon} tone="ink3" size={13} />
        <Text style={{ flexShrink: 1, color: colors.ink3, fontSize: 12, textAlign: "center" }}>{text}</Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}
