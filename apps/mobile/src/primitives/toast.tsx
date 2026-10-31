import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconData } from "../icons";
import { radius, type } from "../design-tokens";
import { useTheme } from "../theme";

/**
 * Every toast's look, matching desktop's sidebar toast (SidebarToast.tsx): one line on the strongest ink, its icon, text
 * and the Undo or Redo label all in onInk. Status colours and the accent fall under 3:1 on ink in some themes, so the
 * icon says what happened by its shape alone; Done's check sits in a solid badge so it reads at a glance.
 */
export function ToastPill({
  text,
  icon,
  badge,
  action,
}: {
  text: string;
  icon?: IconData;
  /** Shows `icon` inside a solid onInk circle (Done's check). */
  badge?: boolean;
  action?: { label: string; onPress: () => void };
}) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        maxWidth: 360,
        alignSelf: "stretch",
        minHeight: 52,
        paddingLeft: 16,
        paddingRight: action ? 8 : 16,
        paddingVertical: 12,
        borderRadius: radius.full,
        borderCurve: "continuous",
        backgroundColor: colors.ink,
        boxShadow: "0 8px 28px #00000017",
      }}
    >
      {icon && badge ? (
        <View style={{ width: 22, height: 22, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.onInk }}>
          <Icon icon={icon} color={colors.ink} size={14} strokeWidth={2.6} />
        </View>
      ) : icon ? (
        <Icon icon={icon} color={colors.onInk} size={18} />
      ) : null}
      <Text style={{ flex: 1, color: colors.onInk, fontSize: type.subheadline, fontWeight: "600" }}>{text}</Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={12}
          onPress={action.onPress}
          // A thumb-sized target: a missed Undo leaves the Chat deleted or Done.
          style={({ pressed }) => ({
            minWidth: 56,
            minHeight: 44,
            marginVertical: -10,
            paddingHorizontal: 8,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: colors.onInk, fontSize: type.subheadline, fontWeight: "600" }}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A brief confirmation over the current screen, gone after a few seconds. Mount for each new action. */
export function Toast({ text }: { text: string }) {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: Math.max(insets.bottom + 12, 24), alignItems: "center" }}>
      <ToastPill text={text} />
    </View>
  );
}
