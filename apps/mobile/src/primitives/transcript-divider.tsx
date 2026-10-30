import React from "react";
import { Text, View } from "react-native";
import { lineHeight, type } from "../design-tokens";
import { Icon, type IconData } from "../icons";
import { useTheme } from "../theme";

/**
 * A transcript event between two rules, as on desktop: an icon and a caption 12 label in ink3. `label` is what a screen
 * reader reads and the default text; `children` replace the text (styled parts), `leading` the icon (a spinner),
 * `trailing` sits after it (an action button, which keeps its own role).
 */
export function TranscriptDivider({
  label,
  icon,
  leading,
  trailing,
  children,
}: {
  label: string;
  icon?: IconData;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const rule = <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 }}>
      {rule}
      <View
        accessible
        accessibilityLabel={label}
        style={{ flexShrink: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 6 }}
      >
        {leading ?? (icon ? <Icon icon={icon} tone="ink3" size={12} /> : null)}
        {children ?? (
          <Text style={{ flexShrink: 1, color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1, textAlign: "center" }}>{label}</Text>
        )}
      </View>
      {trailing}
      {rule}
    </View>
  );
}
