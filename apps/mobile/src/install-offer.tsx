import { useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { INSTALL_OFFERS } from "@milagre/shared/providers";
import type { ModelProvider } from "@milagre/shared/model";
import { ProviderLogo } from "./icons";
import { PillButton, useStyles } from "./ui";
import { lineHeight, type } from "./design-tokens";
import { useTheme } from "./theme";

/** Offers an opt-in agent that isn't installed on the computer (Pi): what it adds and the command that installs it. */
export function InstallOffer({ provider }: { provider: ModelProvider }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  const offer = INSTALL_OFFERS[provider];
  if (!offer) return null;
  return (
    <View style={[styles.card, { gap: 8 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <ProviderLogo provider={provider} size={16} />
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>
          {offer.title}
        </Text>
      </View>
      <Text style={styles.caption}>{offer.detail}</Text>
      <Text selectable style={styles.code}>
        {offer.command}
      </Text>
      <Text style={styles.caption}>{offer.after}</Text>
      <PillButton
        title={copied ? "Copied" : "Copy install command"}
        secondary
        style={{ alignSelf: "flex-start" }}
        onPress={() =>
          void Clipboard.setStringAsync(offer.command).then(
            () => setCopied(true),
            () => {},
          )
        }
      />
    </View>
  );
}
