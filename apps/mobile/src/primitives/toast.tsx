import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconData } from "../icons";
import { radius, type } from "../design-tokens";
import { useTheme } from "../theme";

/**
 * Every toast's look, matching desktop's (lib/toast.ts): an ink pill, its icon, text and Undo all in onInk. Status
 * colours and the accent fall under 3:1 on ink in some themes, so the icon says what happened by its shape alone.
 */
export function ToastPill({ text, icon, onUndo }: { text: string; icon?: IconData; onUndo?: () => void }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        maxWidth: 360,
        minHeight: 48,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: radius.full,
        borderCurve: "continuous",
        backgroundColor: colors.ink,
        boxShadow: "0 8px 28px #00000017",
      }}
    >
      {icon ? <Icon icon={icon} color={colors.onInk} size={18} /> : null}
      <Text style={{ flexShrink: 1, color: colors.onInk, fontSize: type.subheadline, fontWeight: "500" }}>{text}</Text>
      {onUndo ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo"
          hitSlop={12}
          onPress={onUndo}
          // A thumb-sized target: a missed Undo leaves the Chat deleted or Done.
          style={({ pressed }) => ({
            minWidth: 44,
            minHeight: 44,
            marginVertical: -10,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: colors.onInk, fontSize: type.subheadline, fontWeight: "600" }}>Undo</Text>
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
