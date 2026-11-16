import React from "react";
import { Pressable, Text, View } from "react-native";
import { over } from "@milagre/shared/themes";
import { lineHeight, radius, type } from "../design-tokens";
import { useTheme } from "../theme";
import { tap } from "./tap";
import { useHover } from "./hover";
import { pressStyle } from "./press-style";

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
