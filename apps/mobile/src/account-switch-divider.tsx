import { Text, View } from "react-native";
import { UserSwitchIcon } from "@hugeicons/core-free-icons";
import type { AccountSwitchContext } from "@milagre/shared/model";
import { accountSwitchText, limitResetText } from "@milagre/shared/usage-limit";
import { Icon } from "./icons";
import { useTheme } from "./theme";

/** Where a Chat continued on another account after the usage limit, as on desktop. */
export function AccountSwitchDivider({ context }: { context: AccountSwitchContext }) {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel={accountSwitchText(context)} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <View style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 }}>
        <Icon icon={UserSwitchIcon} tone="ink3" size={13} />
        <Text style={{ color: colors.ink3, fontSize: 12 }}>Switched to</Text>
        <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink2, fontSize: 12, fontWeight: "500" }}>
          {context.label}
        </Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
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
