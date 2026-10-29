import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { currentConfirmation } from "../confirm-store";
import { useStyles } from "../ui";
import { useTheme } from "../theme";

/**
 * A confirmation as a bottom sheet: the question, then its buttons, Cancel last. The choice runs once the sheet has
 * gone, so whatever it does next (leaving the Chat, another sheet) never fights the sheet's own dismissal.
 */
export default function ConfirmSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [entry] = useState(currentConfirmation);
  const chosen = useRef<number | null>(null);
  useEffect(() => {
    if (!entry) {
      router.back();
      return;
    }
    return () => entry.choose(chosen.current);
  }, [entry]);
  if (!entry) return null;
  const order = entry.buttons
    .map((button, index) => ({ button, index }))
    .sort((a, b) => Number(a.button.style === "cancel") - Number(b.button.style === "cancel"));
  return (
    <View style={{ paddingTop: 28, paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16) + 4, gap: 20 }}>
      <View style={{ gap: 8 }}>
        <Text accessibilityRole="header" style={[styles.subtitle, { textAlign: "center" }]}>
          {entry.title}
        </Text>
        {entry.message ? <Text style={[styles.muted, { textAlign: "center" }]}>{entry.message}</Text> : null}
      </View>
      <View style={{ gap: 10 }}>
        {order.map(({ button, index }) => {
          const cancel = button.style === "cancel";
          return (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={button.text}
              onPress={() => {
                chosen.current = index;
                router.back();
              }}
              style={({ pressed }) => ({
                minHeight: 52,
                borderRadius: 26,
                borderCurve: "continuous",
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 18,
                backgroundColor: cancel ? "transparent" : colors.field,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text
                style={{
                  fontSize: 17,
                  fontWeight: cancel ? "500" : "600",
                  color: button.style === "destructive" ? colors.redInk : cancel ? colors.ink2 : colors.ink,
                }}
              >
                {button.text}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
