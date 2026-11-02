import React from "react";
import { Text, View } from "react-native";
import { lineHeight, type } from "../design-tokens";
import { Icon, type IconData } from "../icons";
import { useTheme } from "../theme";
import { PillButton } from "./pill-button";

/**
 * An empty list or screen, bare (no card) and centred, as desktop's EmptyState: a 24pt ink4 icon, a 17/22 semibold
 * title (no full stop), help in 15/20 ink3 (ending with one) at most 320 wide, and an optional small secondary action.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: IconData;
  title: string;
  /** The help line; a string is styled, anything else drawn as given. */
  children?: React.ReactNode;
  action?: { title: string; onPress: () => void; icon?: IconData };
}) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: "center", paddingVertical: 40, paddingHorizontal: 24, gap: 4 }}>
      {icon ? <Icon icon={icon} tone="ink4" size={24} /> : null}
      <Text style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600", textAlign: "center" }}>{title}</Text>
      {typeof children === "string" ? (
        <Text style={{ color: colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, textAlign: "center", maxWidth: 320 }}>
          {children}
        </Text>
      ) : (
        children
      )}
      {action ? (
        <PillButton title={action.title} icon={action.icon} onPress={action.onPress} variant="secondary" size="small" style={{ marginTop: 4 }} />
      ) : null}
    </View>
  );
}
