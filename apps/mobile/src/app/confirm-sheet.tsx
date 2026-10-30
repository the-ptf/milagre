import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { currentConfirmation } from "../confirm-store";
import { PillButton, SheetBody, useStyles } from "../ui";

/**
 * A confirmation as a bottom sheet: the question, then its buttons, Cancel last. The choice runs once the sheet has
 * gone, so whatever it does next (leaving the Chat, another sheet) never fights the sheet's own dismissal.
 */
export default function ConfirmSheet() {
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
        <Text accessibilityRole="header" style={[styles.sheetTitle, { textAlign: "center" }]}>
          {entry.title}
        </Text>
        {entry.message ? <Text style={[styles.muted, { textAlign: "center" }]}>{entry.message}</Text> : null}
      </View>
      <View style={{ gap: 12 }}>
        {order.map(({ button, index }) => {
          const cancel = button.style === "cancel";
          // As desktop's Dialog: the confirm is the ink primary (a red fill when destructive), Cancel a plain ink2 label.
          return (
            <PillButton
              key={index}
              size="large"
              title={button.text}
              variant={cancel ? "plain" : "primary"}
              muted={cancel}
              destructive={button.style === "destructive"}
              onPress={() => {
                chosen.current = index;
                router.back();
              }}
            />
          );
        })}
      </View>
    </SheetBody>
  );
}
