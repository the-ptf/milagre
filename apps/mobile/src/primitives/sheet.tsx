import React, { Children, Fragment, isValidElement } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { lineHeight, space, type } from "../design-tokens";
import { useTheme } from "../theme";
import { useStyles } from "./styles";

export function useSheetBottomInset() {
  return Math.max(useSafeAreaInsets().bottom, space.xl);
}

const buttons = (slot: React.ReactNode) =>
  isValidElement<{ children?: React.ReactNode }>(slot) && slot.type === Fragment ? Children.count(slot.props.children) : Children.count(slot);

export function SheetHeader({
  title,
  subtitle,
  subtitleEllipsis = "tail",
  center,
  leading,
  trailing,
  style,
}: {
  title?: string;
  subtitle?: string;
  subtitleEllipsis?: "tail" | "middle";
  center?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const slot = Math.max(buttons(leading), buttons(trailing)) > 1 ? 88 : 40;
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: space.gutter, paddingTop: 16, paddingBottom: 8 }, style]}>
      <View style={{ minWidth: slot, flexDirection: "row", gap: 8, justifyContent: "flex-start" }}>{leading}</View>
      {center ?? (
        <View accessible accessibilityRole="header" accessibilityLabel={[title, subtitle].filter(Boolean).join(", ")} style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={[styles.sheetTitle, { textAlign: "center" }]}>
            {title}
          </Text>
          {subtitle ? (
            <Text
              numberOfLines={1}
              ellipsizeMode={subtitleEllipsis}
              style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1, textAlign: "center" }}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      )}
      <View style={{ minWidth: slot, flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>{trailing}</View>
    </View>
  );
}

export function SheetBody({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const bottom = useSheetBottomInset();
  return <View style={[{ paddingTop: space.xxl, paddingHorizontal: space.gutter, paddingBottom: bottom, gap: 12 }, style]}>{children}</View>;
}
