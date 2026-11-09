import React from "react";
import { Pressable, Text, View } from "react-native";
import { lineHeight, type } from "../design-tokens";
import { Icon, type IconData } from "../icons";
import { useTheme } from "../theme";
import { tap } from "./tap";
import { pressStyle } from "./press-style";

/**
 * A transcript event between two rules, as on desktop: an icon and a caption 12 label in ink3, 12 from each rule, on one
 * line (a long label keeps its start and end). `label` is what a screen reader reads and the default text; `children`
 * replace the text (styled parts; mono figures at caption2 11), `leading` the icon (a spinner), `trailing` sits after it
 * (an action button, which keeps its own role). With `onPress` the whole divider is a button (a handoff, a Link).
 */
export function TranscriptDivider({
  label,
  icon,
  leading,
  trailing,
  onPress,
  hint,
  children,
}: {
  label: string;
  icon?: IconData;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  /** What pressing does, for VoiceOver ("Opens the handoff brief"); only with `onPress`. */
  hint?: string;
  children?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const rule = <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />;
  const body = (
    <>
      {rule}
      <View
        accessible={!onPress}
        accessibilityLabel={onPress ? undefined : label}
        style={{ flexShrink: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 6 }}
      >
        {leading ?? (icon ? <Icon icon={icon} tone="ink3" size={12} /> : null)}
        {children ?? (
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            style={{ flexShrink: 1, color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1, textAlign: "center" }}
          >
            {label}
          </Text>
        )}
      </View>
      {trailing}
      {rule}
    </>
  );
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingVertical: 6 };
  if (!onPress) return <View style={row}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [row, pressStyle({ pressed, kind: "row" })]}
    >
      {body}
    </Pressable>
  );
}
