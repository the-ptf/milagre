import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { lineHeight, type } from "../design-tokens";
import { useTheme } from "../theme";
import { useStyles } from "./styles";
import { SectionLabel } from "./section-label";

/** A grouped list: its SectionLabel, the rows in one card with separators inset past the 20pt icon, and a note under it. */
export function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode[] }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const rows = children.filter(Boolean);
  return (
    <View style={{ gap: 8 }}>
      {title ? <SectionLabel style={{ paddingHorizontal: 16 }}>{title}</SectionLabel> : null}
      <View style={[styles.card, { paddingVertical: 0, paddingHorizontal: 16, gap: 0 }]}>
        {rows.map((row, index) => (
          <View key={index}>
            {index > 0 && <View style={[styles.separator, { marginLeft: 32 }]} />}
            {row}
          </View>
        ))}
      </View>
      {footer ? <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, paddingHorizontal: 16 }}>{footer}</Text> : null}
    </View>
  );
}
