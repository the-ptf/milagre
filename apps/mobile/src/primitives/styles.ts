import { StyleSheet } from "react-native";
import { lineHeight, radius, space, type } from "../design-tokens";
import { createStylesHook, fonts, type Palette } from "../theme";

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.page },
    content: { padding: space.gutter, gap: space.section, paddingBottom: space.xxxl },
    row: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
    card: {
      backgroundColor: colors.surface,
      padding: 16,
      borderRadius: radius.card,
      borderCurve: "continuous",
      gap: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    title: { color: colors.ink, fontSize: type.largeTitle, lineHeight: lineHeight.largeTitle, fontWeight: "700", letterSpacing: -0.6 },
    subtitle: { color: colors.ink, fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600" },
    text: { color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body },
    muted: { color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline },
    label: { color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" },
    caption: { color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 },
    /** A section's header above its rows: sentence case, no tracking (SectionLabel renders it with the header role). */
    section: { color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" },
    input: {
      backgroundColor: colors.field,
      color: colors.ink,
      fontSize: type.body,
      borderRadius: radius.control,
      borderCurve: "continuous",
      paddingHorizontal: 16,
      paddingVertical: 12,
      minHeight: 44,
    },
    error: { backgroundColor: colors.redTint, borderRadius: radius.card, borderCurve: "continuous", padding: 16, gap: 12 },
    code: { color: colors.ink, fontSize: type.footnote, lineHeight: 20, fontFamily: fonts.mono },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  });

export type Styles = ReturnType<typeof makeStyles>;

/** The shared styles for the current theme, built once per palette. */
export const useStyles = createStylesHook(makeStyles);
