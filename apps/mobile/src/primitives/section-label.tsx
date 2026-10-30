import { Text, type StyleProp, type TextStyle } from "react-native";
import { useStyles } from "./styles";

/** A section's header above its rows: footnote 13 medium in ink2, sentence case, no tracking, read as a header. */
export function SectionLabel({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const styles = useStyles();
  return (
    <Text accessibilityRole="header" style={[styles.section, style]}>
      {children}
    </Text>
  );
}
