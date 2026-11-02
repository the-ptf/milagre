import React from "react";
import { Pressable, Text, View } from "react-native";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons";
import { useTheme } from "../theme";
import { useStyles } from "./styles";
import { tap } from "./tap";
import { useHover } from "./hover";
import { pressStyle } from "./press-style";
import { CheckboxBox } from "./checkbox";
import { rowHover, rowMetrics } from "./row-metrics";

/**
 * A choice row with ListRow's metrics (52 one line, 56 with a subtitle, 48 `compact`). `kind="radio"` (one of a list: a
 * mode, a model) shows an 18pt ink tick at the end when checked; `kind="checkbox"` (any of a list: Projects to link)
 * leads with a CheckboxBox. `accessory` sits after the title (a context badge), `trailing` before the tick. Put the
 * rows in a `radiogroup` (Group `role="radiogroup"`) for radios.
 */
export function CheckRow({
  title,
  subtitle,
  checked,
  onPress,
  kind = "radio",
  disabled = false,
  compact = false,
  leading,
  accessory,
  trailing,
  titleLines = 2,
  subtitleLines,
  destructive = false,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  onPress: () => void;
  kind?: "radio" | "checkbox";
  disabled?: boolean;
  compact?: boolean;
  leading?: React.ReactNode;
  accessory?: React.ReactNode;
  trailing?: React.ReactNode;
  titleLines?: number;
  /** Unlimited by default; 1 keeps a path's start and end (middle ellipsis). */
  subtitleLines?: number;
  destructive?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { hovered, ...pointer } = useHover();
  const metrics = rowMetrics({ compact, subtitle: !!subtitle });
  const titleText = (
    <Text numberOfLines={titleLines} style={[{ color: destructive ? colors.redInk : colors.ink, flexShrink: 1 }, metrics.title]}>
      {title}
    </Text>
  );
  return (
    <Pressable
      {...pointer}
      accessibilityRole={kind}
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [metrics.box, hovered && !disabled && rowHover(colors.hover), pressStyle({ pressed, disabled, kind: "row" })]}
    >
      {kind === "checkbox" && <CheckboxBox checked={checked} />}
      {leading}
      <View style={{ flex: 1, gap: 4 }}>
        {accessory ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {titleText}
            {accessory}
          </View>
        ) : (
          titleText
        )}
        {subtitle ? (
          <Text style={styles.caption} numberOfLines={subtitleLines} ellipsizeMode={subtitleLines === 1 ? "middle" : "tail"}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {kind === "radio" && checked && <Icon icon={Tick02Icon} tone="ink" size={18} />}
    </Pressable>
  );
}
