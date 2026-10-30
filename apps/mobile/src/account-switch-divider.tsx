import { Text } from "react-native";
import { UserSwitchIcon } from "@hugeicons/core-free-icons";
import type { AccountSwitchContext } from "@milagre/shared/model";
import { accountSwitchText } from "@milagre/shared/usage-limit";
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
