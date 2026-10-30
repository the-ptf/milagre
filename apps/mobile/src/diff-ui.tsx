import { Text, View } from "react-native";
import type { DiffFileEntry } from "@milagre/shared/git-diff";
import { lineHeight, radius, type } from "./design-tokens";
import { fonts, useTheme, type Palette } from "./theme";

const statusTable = (colors: Palette) =>
  ({
    added: { letter: "A", label: "Added", color: colors.add, tint: colors.diffAdd },
    deleted: { letter: "D", label: "Deleted", color: colors.remove, tint: colors.diffRemove },
    modified: { letter: "M", label: "Modified", color: colors.orangeInk, tint: colors.orangeTint },
    renamed: { letter: "R", label: "Renamed", color: colors.accentInk, tint: colors.accentTint },
  }) as const;

/** Desktop's +N −M counts, caption1 by default or footnote beside a section title. */
export function Counts({ added, removed, size = type.caption1 }: { added: number; removed: number; size?: typeof type.caption1 | typeof type.footnote }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityLabel={`${added} added, ${removed} removed`}
      style={{
        fontFamily: fonts.mono,
        fontSize: size,
        lineHeight: size === type.footnote ? lineHeight.footnote : lineHeight.caption1,
        fontVariant: ["tabular-nums"],
      }}
    >
      <Text style={{ color: colors.add }}>+{added}</Text> <Text style={{ color: colors.remove }}>−{removed}</Text>
    </Text>
  );
}

/** Desktop's A/D/M/R status box: 20 square, growing with Dynamic Type up to 1.3x. */
export function StatusBox({ status }: { status: DiffFileEntry["status"] }) {
  const { colors } = useTheme();
  const { letter, label, color, tint } = statusTable(colors)[status];
  return (
    <View
      accessibilityLabel={label}
      style={{
        minWidth: 20,
        minHeight: 20,
        paddingHorizontal: 2,
        borderRadius: radius.chip,
        borderCurve: "continuous",
        backgroundColor: tint,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text maxFontSizeMultiplier={1.3} style={{ color, fontFamily: fonts.mono, fontSize: type.caption2, lineHeight: lineHeight.caption2, fontWeight: "600" }}>
        {letter}
      </Text>
    </View>
  );
}
