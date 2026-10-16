import { Text, View } from "react-native";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { RELOAD_TEXT } from "@milagre/shared/chat-reload";
import { Icon } from "./icons";
import { useTheme } from "./theme";

/** Where the user reloaded the Chat's agent, as on desktop. */
export function ChatReloadDivider() {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel={RELOAD_TEXT} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 }}>
        <Icon icon={RefreshIcon} tone="ink3" size={13} />
        <Text style={{ color: colors.ink3, fontSize: 12 }}>{RELOAD_TEXT}</Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}
