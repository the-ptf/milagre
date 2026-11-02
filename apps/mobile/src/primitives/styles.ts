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
    title: { color: colors.ink, fontSize: type.largeTitle, lineHeight: lineHeight.largeTitle, fontWeight: "700" },
    subtitle: { color: colors.ink, fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600" },
    text: { color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body },
    muted: { color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline },
    label: { color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" },
    caption: { color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 },
    /** A meta line: footnote 13/18 in ink3. */
    footnote: { color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote },
    /** A sheet's or card's title: 17/22 semibold ink (SheetHeader draws it). */
    sheetTitle: { color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600" },
    /** @deprecated Render `SectionLabel`; this is its text style (13 medium ink3). */
    section: { color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" },
    /** A text field: field fill with a 1px lineStrong edge (Field turns it accent while focused, redInk when invalid). */
    input: {
      backgroundColor: colors.field,
      color: colors.ink,
      fontSize: type.body,
      borderRadius: radius.control,
      borderCurve: "continuous",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      paddingHorizontal: 16,
      paddingVertical: 12,
      minHeight: 44,
    },
    error: { backgroundColor: colors.redTint, borderRadius: radius.card, borderCurve: "continuous", padding: 16, gap: 12 },
    code: { color: colors.ink, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontFamily: fonts.mono },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  });

export type Styles = ReturnType<typeof makeStyles>;

/** The shared styles for the current theme, built once per palette. */
export const useStyles = createStylesHook(makeStyles);
