import React from "react";
import { Pressable, Text, View } from "react-native";
import { over } from "@milagre/shared/themes";
import { lineHeight, radius, type } from "../design-tokens";
import { useTheme } from "../theme";
import { tap } from "./tap";
import { useHover } from "./hover";
import { pressStyle } from "./press-style";

/**
 * A pill chip: 32pt tall (44 with its hitSlop), 13/18 medium in both states (the fill marks it, so the width holds):
 * ink fill with an onInk label when selected, the surface with a 1px edge and an ink2 label otherwise. With `selected`
 * it's a radio in a `radiogroup` (a checkbox with `multiple`, a tab in a `tablist` with `role="tab"`); without
 * `onPress` it's a static label (a static tag is `Tag`). `leading` takes a dot or a 12/16 icon, `trailing` a dot or a count.
 */
export function Chip({
  label,
  selected,
  multiple = false,
  role,
  onPress,
  disabled = false,
  leading,
  trailing,
  accessibilityLabel,
}: {
  label: string;
  selected?: boolean;
  multiple?: boolean;
  role?: "tab";
  onPress?: () => void;
  disabled?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const { hovered, ...pointer } = useHover();
  const on = !!selected;
  const look = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: radius.full,
    borderCurve: "continuous" as const,
    backgroundColor: on ? colors.ink : hovered && !disabled ? over(colors.hover, colors.surface) : colors.surface,
    borderWidth: on ? 0 : 1,
    borderColor: colors.lineStrong,
  };
  const content = (
    <>
      {leading}
      <Text numberOfLines={1} style={{ color: on ? colors.onInk : colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}>
        {label}
      </Text>
      {trailing}
    </>
  );
  if (!onPress) return <View style={look}>{content}</View>;
  const kind = role ?? (selected === undefined ? "button" : multiple ? "checkbox" : "radio");
  return (
    <Pressable
      {...pointer}
      accessibilityRole={kind}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={kind === "button" ? { disabled } : kind === "tab" ? { selected: on, disabled } : { checked: on, disabled }}
      hitSlop={6}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [look, pressStyle({ pressed, disabled })]}
    >
      {content}
    </Pressable>
  );
}
