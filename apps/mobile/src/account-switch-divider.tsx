import { View } from "react-native";
import { Text } from "react-native";
import { UserSwitchIcon } from "@hugeicons/core-free-icons";
import type { AccountSwitchContext } from "@milagre/shared/model";
import { accountSwitchText, limitResetText } from "@milagre/shared/usage-limit";
import { lineHeight, type } from "./design-tokens";
import { TranscriptDivider } from "./primitives/transcript-divider";
import { useTheme } from "./theme";

/** Where a Chat continued on another account after the usage limit, as on desktop. */
export function AccountSwitchDivider({ context }: { context: AccountSwitchContext }) {
  const { colors } = useTheme();
  const caption = { fontSize: type.caption1, lineHeight: lineHeight.caption1 };
  return (
    <TranscriptDivider label={accountSwitchText(context)} icon={UserSwitchIcon}>
      <Text style={[caption, { color: colors.ink3 }]}>Switched to</Text>
      <Text numberOfLines={1} style={[caption, { flexShrink: 1, color: colors.ink2, fontWeight: "500" }]}>
        {context.label}
      </Text>
    </TranscriptDivider>
  );
}

export function LimitResetDivider() {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel={limitResetText()} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <Text style={{ color: colors.ink3, fontSize: 12, flexShrink: 1 }}>{limitResetText()}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}
