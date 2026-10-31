import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Icon, type IconData } from "./icons";
import { useTheme } from "./theme";
import { useStyles } from "./ui";
import { Findable } from "./settings-find";

/** A grouped list: its header, the rows in one card with inset separators, and a note under it. */
export function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode[] }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const rows = children.filter(Boolean);
  return (
    <View style={{ gap: 8 }}>
      {title ? (
        <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 13, paddingHorizontal: 16 }}>
          {title}
        </Text>
      ) : null}
      <View style={[styles.card, { paddingVertical: 0, paddingHorizontal: 16, gap: 0 }]}>
        {rows.map((row, index) => (
          <View key={index}>
            {index > 0 && <View style={[styles.separator, { marginLeft: 36 }]} />}
            {row}
          </View>
        ))}
      </View>
      {footer ? <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, paddingHorizontal: 16 }}>{footer}</Text> : null}
    </View>
  );
}

/** One Settings row: icon, title, the current value when it's known without asking the Mac, and a chevron. */
export function Row({
  title,
  icon,
  leading,
  value,
  trailing,
  destructive = false,
  chevron = true,
  disabled = false,
  selected,
  onPress,
}: {
  title: string;
  icon?: IconData;
  leading?: ReactNode;
  value?: string;
  /** Replaces the value and the chevron, for a switch. */
  trailing?: ReactNode;
  destructive?: boolean;
  chevron?: boolean;
  disabled?: boolean;
  /** A row of a one-choice list: VoiceOver says whether it is the chosen one. */
  selected?: boolean;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Findable title={title}>
      <Pressable
        accessibilityRole={onPress ? "button" : undefined}
        accessibilityLabel={value ? `${title}. ${value}` : title}
        accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
        disabled={disabled || !onPress}
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 14,
          minHeight: 52,
          opacity: disabled ? 0.4 : pressed ? 0.5 : 1,
        })}
      >
        {leading ?? (icon ? <Icon icon={icon} tone={destructive ? "red" : "ink"} size={22} /> : null)}
        <Text numberOfLines={1} style={{ flex: 1, color: destructive ? colors.redInk : colors.ink, fontSize: 17 }}>
          {title}
        </Text>
        {trailing ?? (
          <>
            {value ? (
              <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 17, maxWidth: "45%" }}>
                {value}
              </Text>
            ) : null}
            {chevron ? <Icon icon={ArrowRight01Icon} tone="ink3" size={16} /> : null}
          </>
        )}
      </Pressable>
    </Findable>
  );
}
