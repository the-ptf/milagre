import React from "react";
import { Pressable, Text, View } from "react-native";
import { lineHeight, radius, type } from "../design-tokens";
import { useTheme } from "../theme";
import { tap } from "./tap";
import { pressStyle } from "./press-style";

/**
 * A pill chip: 32pt tall (44 with its hitSlop), ink fill with an onInk label when selected, the surface with a border
 * otherwise. With `selected` it's a radio in a `radiogroup` (or a checkbox with `multiple`); without `onPress` it's a
 * static label. `leading` takes a dot or a 12/16 icon.
 */
export function Chip({
  label,
  selected,
  multiple = false,
  onPress,
  disabled = false,
  leading,
  accessibilityLabel,
}: {
  label: string;
  selected?: boolean;
  multiple?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  leading?: React.ReactNode;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const on = !!selected;
  const look = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: radius.full,
    borderCurve: "continuous" as const,
    backgroundColor: on ? colors.ink : colors.surface,
    borderWidth: on ? 0 : 1,
    borderColor: colors.lineStrong,
  };
  const content = (
    <>
      {leading}
      <Text
        numberOfLines={1}
        style={{ color: on ? colors.onInk : colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: on ? "600" : "500" }}
      >
        {label}
      </Text>
    </>
  );
  if (!onPress) return <View style={look}>{content}</View>;
  const role = selected === undefined ? "button" : multiple ? "checkbox" : "radio";
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={role === "button" ? { disabled } : { checked: on, disabled }}
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
