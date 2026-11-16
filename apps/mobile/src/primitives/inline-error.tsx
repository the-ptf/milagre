import { Text, type StyleProp, type TextStyle } from "react-native";
import { lineHeight, type } from "../design-tokens";
import { useTheme } from "../theme";
import { useAnnounce } from "./announce";

export function InlineError({ message, warning = false, style }: { message?: string | null; warning?: boolean; style?: StyleProp<TextStyle> }) {
  const { colors } = useTheme();
  useAnnounce(message, { onMount: true });
  if (!message) return null;
  return (
    <Text
      accessibilityRole="alert"
      selectable
      style={[{ color: warning ? colors.orangeInk : colors.redInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }, style]}
    >
      {message}
    </Text>
  );
}
