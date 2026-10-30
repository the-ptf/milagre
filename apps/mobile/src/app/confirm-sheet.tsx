import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { currentConfirmation } from "../confirm-store";
import { SheetBody, pressStyle, tap, useStyles } from "../ui";
import { useTheme } from "../theme";
import { lineHeight, radius, type } from "../design-tokens";

/**
 * A confirmation as a bottom sheet: the question, then its buttons, Cancel last. The choice runs once the sheet has
 * gone, so whatever it does next (leaving the Chat, another sheet) never fights the sheet's own dismissal.
 */
export default function ConfirmSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
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
    <SheetBody style={{ gap: 24 }}>
      <View style={{ gap: 8 }}>
        <Text
          accessibilityRole="header"
          style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600", textAlign: "center" }}
        >
          {entry.title}
        </Text>
        {entry.message ? <Text style={[styles.muted, { textAlign: "center" }]}>{entry.message}</Text> : null}
      </View>
      <View style={{ gap: 12 }}>
        {order.map(({ button, index }) => {
          const cancel = button.style === "cancel";
          return (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={button.text}
              onPress={() => {
                tap();
                chosen.current = index;
                router.back();
              }}
              style={({ pressed }) => [
                {
                  minHeight: 52,
                  borderRadius: radius.full,
                  borderCurve: "continuous",
                  alignItems: "center",
                  justifyContent: "center",
                  paddingHorizontal: 16,
                  backgroundColor: cancel ? "transparent" : colors.field,
                },
                pressStyle({ pressed, filled: !cancel }),
              ]}
            >
              <Text
                style={{
                  fontSize: type.body,
                  lineHeight: lineHeight.body,
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
    </SheetBody>
  );
}
