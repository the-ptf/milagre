import React from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { lineHeight, space, type } from "../design-tokens";
import { useTheme } from "../theme";

/** The bottom padding a sheet's content keeps above the home indicator (16 without one). For a ScrollView's `contentContainerStyle`. */
export function useSheetBottomInset() {
  return Math.max(useSafeAreaInsets().bottom, space.xl);
}

/**
 * A sheet's top bar: its 17 semibold title centred between two 40pt slots, usually CircleButtons (Close on the leading
 * side, a filled Done on the trailing side). An empty slot keeps the title centred.
 */
export function SheetHeader({
  title,
  leading,
  trailing,
  style,
}: {
  title: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: space.gutter, paddingTop: 16, paddingBottom: 8 }, style]}>
      <View style={{ minWidth: 40, alignItems: "flex-start" }}>{leading}</View>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={{ flex: 1, textAlign: "center", color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600" }}
      >
        {title}
      </Text>
      <View style={{ minWidth: 40, alignItems: "flex-end" }}>{trailing}</View>
    </View>
  );
}

/** A sheet's content that doesn't scroll: the 16 gutter, 24 above, and the bottom inset below. */
export function SheetBody({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const bottom = useSheetBottomInset();
  return <View style={[{ paddingTop: space.xxl, paddingHorizontal: space.gutter, paddingBottom: bottom, gap: 12 }, style]}>{children}</View>;
}
