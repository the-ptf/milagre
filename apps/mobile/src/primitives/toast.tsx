import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { chrome, lineHeight, radius, space, type } from "../design-tokens";
import { useTheme } from "../theme";
import { announce } from "./announce";

/**
 * A brief confirmation over the current screen, an ink capsule as on desktop: ink fill, onInk label, read aloud once on
 * VoiceOver and TalkBack. `placement` "top" floats 8 under the header (`chrome.header`) without moving the list,
 * "bottom" above the home indicator. Mount for each new action.
 */
export function Toast({ text, placement = "bottom" }: { text: string; placement?: "top" | "bottom" }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    announce(text);
    const timer = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(timer);
  }, [text]);
  if (!visible) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        { position: "absolute", left: 16, right: 16, alignItems: "center", zIndex: 10 },
        placement === "top" ? { top: insets.top + chrome.header + space.md } : { bottom: Math.max(insets.bottom + 12, 24) },
      ]}
    >
      <View
        style={{
          maxWidth: 360,
          borderRadius: radius.card,
          borderCurve: "continuous",
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: colors.ink,
          boxShadow: colors.shadowRaised,
        }}
      >
        <Text style={{ color: colors.onInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{text}</Text>
      </View>
    </View>
  );
}
