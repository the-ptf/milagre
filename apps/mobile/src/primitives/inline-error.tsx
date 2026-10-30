import { Text, type StyleProp, type TextStyle } from "react-native";
import { lineHeight, type } from "../design-tokens";
import { useTheme } from "../theme";
import { useAnnounce } from "./announce";

/**
 * A field-level or in-card error (tier 1), as desktop's InlineError: footnote 13/18 in redInk (`warning` in orangeInk),
 * read aloud as it shows. Renders nothing when `message` is empty, so it can sit under a field unconditionally. A
 * blocking failure with a retry is an `ErrorNotice`.
 */
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
