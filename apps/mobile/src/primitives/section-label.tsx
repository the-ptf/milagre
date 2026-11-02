import type { ReactNode, Ref } from "react";
import { Text, View, type StyleProp, type TextInstance, type TextStyle } from "react-native";
import { useStyles } from "./styles";

/**
 * A group's heading above its card: footnote 13 medium in ink3, sentence case, no tracking, read as a header. It sits 16
 * in from the card's edge, lined up with the rows' text; `flush` drops that for a heading over plain content. `trailing`
 * sits at the other end (a count, a refresh button); `ref` reaches the text, to move focus to it.
 */
export function SectionLabel({
  children,
  trailing,
  flush = false,
  style,
  ref,
}: {
  children: string;
  trailing?: ReactNode;
  flush?: boolean;
  style?: StyleProp<TextStyle>;
  ref?: Ref<TextInstance>;
}) {
  const styles = useStyles();
  const inset = { paddingHorizontal: flush ? 0 : 16 };
  if (trailing === undefined)
    return (
      <Text ref={ref} accessibilityRole="header" style={[styles.section, inset, style]}>
        {children}
      </Text>
    );
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, inset]}>
      <Text ref={ref} accessibilityRole="header" style={[styles.section, { flexShrink: 1 }, style]}>
        {children}
      </Text>
      {typeof trailing === "string" || typeof trailing === "number" ? (
        <Text style={[styles.section, { fontVariant: ["tabular-nums"] }]}>{trailing}</Text>
      ) : (
        trailing
      )}
    </View>
  );
}
