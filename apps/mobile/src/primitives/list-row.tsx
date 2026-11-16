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
import { RowCheckbox } from "./row-checkbox";
import { Findable } from "../settings-find";
import { rowHover, rowMetrics } from "./row-metrics";

const STACK_FONT_SCALE = 1.35;

export function ListRow({
  title,
  subtitle,
  subtitleLines = 1,
  inlineSubtitle = false,
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
  selected = false,
  leading,
  trailing,
}: {
  title: string;
  subtitle?: string;
  subtitleLines?: number;
  inlineSubtitle?: boolean;
  subtitleTone?: Tone;
  titleLines?: number;
  value?: string;
  icon?: IconData;
  compact?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  toggle?: { value: boolean; onChange: () => void; label?: string };
  disabled?: boolean;
  destructive?: boolean;
  chevron?: boolean;
  /** The page this row opens is the one showing beside it (the iPad Settings sidebar): a filled row, without its chevron. */
  selected?: boolean;
  leading?: React.ReactNode;
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
    <Findable title={title}>
      <Pressable
        {...(interactive ? pointer : {})}
        accessible={interactive}
        accessibilityRole={toggle ? "checkbox" : onPress ? "button" : undefined}
        accessibilityLabel={[toggle?.label ?? title, subtitle, value].filter(Boolean).join(". ")}
        accessibilityState={toggle ? { checked: toggle.value, disabled } : { disabled, selected }}
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
        style={({ pressed }) => [
          metrics.box,
          selected ? rowHover(colors.hover2) : hovered && interactive && !disabled && rowHover(colors.hover),
          pressStyle({ pressed, disabled, kind: "row" }),
        ]}
      >
        {leading ?? (icon ? <Icon icon={icon} tone={destructive ? "red" : "ink"} size={20} /> : null)}
        <View
          style={{
            flex: 1,
            gap: inlineSubtitle ? 8 : 4,
            flexDirection: inlineSubtitle && !stacked ? "row" : "column",
            alignItems: inlineSubtitle && !stacked ? "center" : undefined,
          }}
        >
          <Text numberOfLines={titleLines} style={[styles.text, metrics.title, inlineSubtitle && { flex: 1 }, destructive && { color: colors.redInk }]}>
            {title}
          </Text>
          {subtitle && (
            <Text
              style={[styles.caption, { color: colors[subtitleTone] }]}
              numberOfLines={subtitleLines}
              ellipsizeMode={subtitleLines === 1 ? "middle" : "tail"}
            >
              {subtitle}
            </Text>
          )}
          {stacked ? valueText : null}
        </View>
        {toggle ? (
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <RowCheckbox selected={toggle.value} onPress={toggle.onChange} disabled={disabled} label={toggle.label ?? title} />
          </View>
        ) : (
          (trailing ?? (
            <>
              {stacked ? null : valueText}
              {chevron && !selected ? <Icon icon={ArrowRight01Icon} tone="ink3" size={16} /> : null}
            </>
          ))
        )}
      </Pressable>
    </Findable>
  );
}
