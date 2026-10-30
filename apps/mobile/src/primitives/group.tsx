import { Children, isValidElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { lineHeight, type } from "../design-tokens";
import { useTheme } from "../theme";
import { useStyles } from "./styles";
import { SectionLabel } from "./section-label";

/**
 * A grouped list: its SectionLabel, the rows in one flat card (hairline edge, radius 14, padding 0/16) with separators,
 * and an ink3 note under it. Separators start past a row's 20pt icon (`inset` 32), or at the text for icon-less rows
 * (`inset` 0). `role="radiogroup"` with an `accessibilityLabel` holds CheckRow radios. Children may be any nodes;
 * empty ones drop out and each keeps its key.
 */
export function Group({
  title,
  footer,
  inset = 32,
  role,
  accessibilityLabel,
  children,
}: {
  title?: string;
  footer?: string;
  inset?: 0 | 32;
  role?: "radiogroup";
  accessibilityLabel?: string;
  children: ReactNode;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const rows = Children.toArray(children);
  return (
    <View style={{ gap: 8 }}>
      {title ? <SectionLabel>{title}</SectionLabel> : null}
      <View
        accessibilityRole={role}
        accessibilityLabel={role ? (accessibilityLabel ?? title) : undefined}
        style={[styles.card, { paddingVertical: 0, paddingHorizontal: 16, gap: 0 }]}
      >
        {rows.map((row, index) => (
          <View key={isValidElement(row) && row.key != null ? row.key : index}>
            {index > 0 && <View style={[styles.separator, { marginLeft: inset }]} />}
            {row}
          </View>
        ))}
      </View>
      {footer ? <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote, paddingHorizontal: 16 }}>{footer}</Text> : null}
    </View>
  );
}
