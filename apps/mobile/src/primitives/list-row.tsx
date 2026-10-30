import React from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { lineHeight, type } from "../design-tokens";
import { Icon, type IconData, type Tone } from "../icons";
import { useTheme } from "../theme";
import { useStyles } from "./styles";
import { tap } from "./tap";
import { useHover } from "./hover";
import { pressStyle } from "./press-style";
import { RowSwitch } from "./row-switch";
import { rowHover, rowMetrics } from "./row-metrics";

/** From this text size the value no longer fits beside the title, so it moves under it. */
const STACK_FONT_SCALE = 1.35;

/**
 * A list row: leading icon, title, an optional subtitle or current value, and a chevron (see `rowMetrics`). With
 * `toggle` the whole row is a switch: a tap anywhere flips it and it reads as one ("Show its Chats, switch, on").
 * Without `onPress` or `toggle` it isn't an element of its own, so VoiceOver reaches what's inside it.
 */
export function ListRow({
  title,
  subtitle,
  subtitleLines = 1,
  subtitleTone = "ink3",
  titleLines = 2,
  value,
  icon,
  onPress,
  onLongPress,
  toggle,
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
  /** The subtitle's ink: `redInk` for a failure. */
  subtitleTone?: Tone;
  titleLines?: number;
  /** The current value, in ink3 before the chevron (a Settings row). */
  value?: string;
  icon?: IconData;
  compact?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  /** The row is a switch: `value` its state, `onChange` flips it, `label` what it reads if not the title. */
  toggle?: { value: boolean; onChange: () => void; label?: string };
  disabled?: boolean;
  destructive?: boolean;
  chevron?: boolean;
  leading?: React.ReactNode;
  /** Replaces the value and the chevron, for a custom accessory. */
  trailing?: React.ReactNode;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { hovered, ...pointer } = useHover();
  const stacked = useWindowDimensions().fontScale >= STACK_FONT_SCALE;
  const metrics = rowMetrics({ compact, subtitle: !!subtitle });
  const press = toggle?.onChange ?? onPress;
  const interactive = !!(press || onLongPress);
  const valueText = value ? (
    <Text
      numberOfLines={stacked ? undefined : 1}
      style={{
        color: colors.ink3,
        ...(subtitle ? { fontSize: type.footnote, lineHeight: lineHeight.footnote } : { fontSize: type.body, lineHeight: lineHeight.body }),
        maxWidth: stacked ? undefined : "45%",
      }}
    >
      {value}
    </Text>
  ) : null;
  return (
    <Pressable
      {...(interactive ? pointer : {})}
      accessible={interactive}
      accessibilityRole={toggle ? "switch" : onPress ? "button" : undefined}
      accessibilityLabel={[toggle?.label ?? title, subtitle, value].filter(Boolean).join(". ")}
      accessibilityState={toggle ? { checked: toggle.value, disabled } : { disabled }}
      disabled={disabled || !interactive}
      onPress={
        press &&
        (() => {
          tap();
          press();
        })
      }
      onLongPress={onLongPress}
      accessibilityActions={onLongPress ? [{ name: "longpress", label: "Actions" }] : undefined}
      onAccessibilityAction={onLongPress}
      style={({ pressed }) => [metrics.box, hovered && interactive && !disabled && rowHover(colors.hover), pressStyle({ pressed, disabled, kind: "row" })]}
    >
      {leading ?? (icon ? <Icon icon={icon} tone={destructive ? "red" : "ink"} size={20} /> : null)}
      <View style={{ flex: 1, gap: 4 }}>
        <Text numberOfLines={titleLines} style={[styles.text, metrics.title, destructive && { color: colors.redInk }]}>
          {title}
        </Text>
        {/* Paths keep their start and end; descriptions can wrap. */}
        {subtitle && (
          <Text style={[styles.caption, { color: colors[subtitleTone] }]} numberOfLines={subtitleLines} ellipsizeMode={subtitleLines === 1 ? "middle" : "tail"}>
            {subtitle}
          </Text>
        )}
        {stacked ? valueText : null}
      </View>
      {toggle ? (
        // The row is the control: its switch only shows the state, so a tap on it isn't counted twice.
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <RowSwitch selected={toggle.value} onPress={toggle.onChange} disabled={disabled} label={toggle.label ?? title} />
        </View>
      ) : (
        (trailing ?? (
          <>
            {stacked ? null : valueText}
            {chevron ? <Icon icon={ArrowRight01Icon} tone="ink3" size={16} /> : null}
          </>
        ))
      )}
    </Pressable>
  );
}
