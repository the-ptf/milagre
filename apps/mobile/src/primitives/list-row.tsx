import React from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons";
import { useStyles } from "./styles";
import { type } from "../design-tokens";
import { Findable } from "../settings-find";

export function ListRow({
  title,
  subtitle,
  subtitleLines = 1,
  inlineSubtitle = false,
  onPress,
  onLongPress,
  disabled = false,
  compact = false,
  leading,
  trailing,
}: {
  title: string;
  subtitle?: string;
  subtitleLines?: number;
  inlineSubtitle?: boolean;
  compact?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const styles = useStyles();
  return (
    <Findable title={title}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityActions={onLongPress ? [{ name: "longpress", label: "Actions" }] : undefined}
        onAccessibilityAction={onLongPress}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingVertical: compact ? 8 : 13,
          minHeight: compact ? 48 : 52,
          opacity: disabled ? 0.4 : pressed ? 0.5 : 1,
        })}
      >
        {leading}
        <View
          style={{ flex: 1, gap: inlineSubtitle ? 8 : 3, flexDirection: inlineSubtitle ? "row" : "column", alignItems: inlineSubtitle ? "center" : undefined }}
        >
          <Text numberOfLines={1} style={[styles.text, { fontWeight: "500" }, inlineSubtitle && { flex: 1 }, compact && { fontSize: 15, lineHeight: 20 }]}>
            {title}
          </Text>
          {/* Paths keep their start and end; descriptions can wrap. */}
          {subtitle && (
            <Text
              style={[styles.caption, inlineSubtitle && { fontSize: type.subheadline, flexShrink: 1 }]}
              numberOfLines={subtitleLines}
              ellipsizeMode={subtitleLines === 1 ? "middle" : "tail"}
            >
              {subtitle}
            </Text>
          )}
        </View>
        {trailing ?? <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />}
      </Pressable>
    </Findable>
  );
}
