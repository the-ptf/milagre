import React from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { lineHeight, type } from "../design-tokens";
import { Icon, type IconData } from "../icons";
import { useTheme } from "../theme";
import { useStyles } from "./styles";
import { tap } from "./tap";
import { pressStyle } from "./press-style";

/**
 * A list row: leading icon, title, an optional subtitle or current value, and a chevron. One line reads at body 17
 * (a Settings row, 52pt); with a subtitle the title is 16 medium over a caption (56pt); `compact` is 15 medium (48pt).
 * Without `onPress` it's a plain row with no button role (a row holding a switch in `trailing`).
 */
export function ListRow({
  title,
  subtitle,
  subtitleLines = 1,
  value,
  icon,
  onPress,
  onLongPress,
  disabled = false,
  compact = false,
  destructive = false,
  chevron = true,
  leading,
  trailing,
}: {
  title: string;
  subtitle?: string;
  subtitleLines?: number;
  /** The current value, in ink3 before the chevron (a Settings row). */
  value?: string;
  icon?: IconData;
  compact?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  chevron?: boolean;
  leading?: React.ReactNode;
  /** Replaces the value and the chevron, for a switch or a custom accessory. */
  trailing?: React.ReactNode;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const titleStyle = compact
    ? { fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" as const }
    : subtitle
      ? { fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "500" as const }
      : { fontSize: type.body, lineHeight: lineHeight.body };
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={[title, subtitle, value].filter(Boolean).join(". ")}
      accessibilityState={{ disabled }}
      disabled={disabled || !onPress}
      onPress={
        onPress &&
        (() => {
          tap();
          onPress();
        })
      }
      onLongPress={onLongPress}
      accessibilityActions={onLongPress ? [{ name: "longpress", label: "Actions" }] : undefined}
      onAccessibilityAction={onLongPress}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: compact ? 8 : 12, minHeight: compact ? 48 : subtitle ? 56 : 52 },
        pressStyle({ pressed, disabled, kind: "row" }),
      ]}
    >
      {leading ?? (icon ? <Icon icon={icon} tone={destructive ? "red" : "ink"} size={20} /> : null)}
      <View style={{ flex: 1, gap: 4 }}>
        <Text numberOfLines={1} style={[styles.text, titleStyle, destructive && { color: colors.redInk }]}>
          {title}
        </Text>
        {/* Paths keep their start and end; descriptions can wrap. */}
        {subtitle && (
          <Text style={styles.caption} numberOfLines={subtitleLines} ellipsizeMode={subtitleLines === 1 ? "middle" : "tail"}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing ?? (
        <>
          {value ? (
            <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.body, lineHeight: lineHeight.body, maxWidth: "45%" }}>
              {value}
            </Text>
          ) : null}
          {chevron ? <Icon icon={ArrowRight01Icon} tone="ink3" size={16} /> : null}
        </>
      )}
    </Pressable>
  );
}
