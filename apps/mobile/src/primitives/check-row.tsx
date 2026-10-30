import React from "react";
import { Pressable, Text, View } from "react-native";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { lineHeight, type } from "../design-tokens";
import { Icon } from "../icons";
import { useTheme } from "../theme";
import { useStyles } from "./styles";
import { tap } from "./tap";
import { pressStyle } from "./press-style";
import { CheckboxBox } from "./checkbox";

/**
 * A choice row. `kind="radio"` (one of a list: a mode, a model) shows an accent tick at the end when checked;
 * `kind="checkbox"` (any of a list: Projects to link) leads with a Checkbox. 56pt with a subtitle, 44 without.
 * Put the rows in a `radiogroup` view for radios.
 */
export function CheckRow({
  title,
  subtitle,
  checked,
  onPress,
  kind = "radio",
  disabled = false,
  leading,
  destructive = false,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  onPress: () => void;
  kind?: "radio" | "checkbox";
  disabled?: boolean;
  leading?: React.ReactNode;
  destructive?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole={kind}
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, minHeight: subtitle ? 56 : 44 },
        pressStyle({ pressed, disabled, kind: "row" }),
      ]}
    >
      {kind === "checkbox" && <CheckboxBox checked={checked} />}
      {leading}
      <View style={{ flex: 1, gap: 4 }}>
        <Text
          numberOfLines={1}
          style={{
            color: destructive ? colors.redInk : colors.ink,
            fontSize: subtitle ? type.callout : type.body,
            lineHeight: subtitle ? lineHeight.callout : lineHeight.body,
            fontWeight: subtitle ? "500" : undefined,
          }}
        >
          {title}
        </Text>
        {subtitle ? <Text style={styles.caption}>{subtitle}</Text> : null}
      </View>
      {kind === "radio" && checked && <Icon icon={Tick02Icon} tone="accent" size={18} />}
    </Pressable>
  );
}
