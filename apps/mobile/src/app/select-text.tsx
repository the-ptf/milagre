import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Cancel01Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import { selectableText } from "../select-text-store";
import { CircleButton, useStyles } from "../ui";
import { useTheme } from "../theme";
import { tap } from "../primitives/tap";

/**
 * A message as plain text in a read-only text view, where a drag selects any part of it (an email, a password, one
 * command) and the system menu copies just that.
 */
export default function SelectTextSheet() {
  const { colors, textPx } = useTheme();
  const styles = useStyles();
  const [text] = useState(selectableText);
  return (
    <View style={[styles.screen, { flex: 1 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
        <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
          Select text
        </Text>
        <CircleButton
          label="Copy all"
          icon={Copy01Icon}
          onPress={() => {
            tap();
            void Clipboard.setStringAsync(text).then(() => router.back());
          }}
        />
      </View>
      <TextInput
        value={text}
        editable={false}
        multiline
        scrollEnabled
        accessibilityLabel="Message text"
        style={{
          flex: 1,
          color: colors.ink,
          fontSize: textPx,
          lineHeight: Math.round(textPx * 1.4667),
          paddingHorizontal: 20,
          paddingTop: 8,
          paddingBottom: 40,
          textAlignVertical: "top",
        }}
      />
    </View>
  );
}
