import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";

/** A brief confirmation over the current screen, matching Chat and page-sharing toasts. Mount for each new action. */
export function Toast({ text }: { text: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: Math.max(insets.bottom + 12, 24), alignItems: "center" }}>
      <View
        accessibilityLiveRegion="polite"
        style={{ maxWidth: 360, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.ink }}
      >
        <Text style={{ color: colors.surface, fontSize: 14 }}>{text}</Text>
      </View>
    </View>
  );
}
