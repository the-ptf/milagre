import { StyleSheet } from "react-native";
import { createStylesHook, fonts, type Palette } from "../theme";

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.page },
    content: { padding: 20, gap: 20, paddingBottom: 36 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
    card: {
      backgroundColor: colors.surface,
      padding: 16,
      borderRadius: 20,
      borderCurve: "continuous",
      gap: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    title: { color: colors.ink, fontSize: 34, fontWeight: "700", letterSpacing: -0.6 },
    subtitle: { color: colors.ink, fontSize: 20, fontWeight: "600" },
    text: { color: colors.ink, fontSize: 16, lineHeight: 23 },
    muted: { color: colors.ink2, fontSize: 15, lineHeight: 21 },
    label: { color: colors.ink2, fontSize: 13, fontWeight: "500" },
    caption: { color: colors.ink3, fontSize: 12 },
    section: { color: colors.ink3, fontSize: 11, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" },
    input: {
      backgroundColor: colors.field,
      color: colors.ink,
      fontSize: 16,
      borderRadius: 12,
      borderCurve: "continuous",
      paddingHorizontal: 14,
      paddingVertical: 12,
      minHeight: 44,
    },
    error: { backgroundColor: colors.redTint, borderRadius: 16, borderCurve: "continuous", padding: 16, gap: 12 },
    code: { color: colors.ink, fontSize: 13, lineHeight: 20, fontFamily: fonts.mono },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  });

export type Styles = ReturnType<typeof makeStyles>;

/** The shared styles for the current theme, built once per palette. */
export const useStyles = createStylesHook(makeStyles);
