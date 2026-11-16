import { lineHeight, radius, type } from "../design-tokens";

export function rowMetrics({ compact = false, subtitle = false }: { compact?: boolean; subtitle?: boolean }) {
  return {
    box: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      paddingVertical: compact ? 8 : 12,
      minHeight: compact ? 48 : subtitle ? 56 : 52,
    },
    title: compact
      ? { fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" as const }
      : subtitle
        ? { fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "500" as const }
        : { fontSize: type.body, lineHeight: lineHeight.body },
  };
}

/** An iPad pointer over a row: the hover fill, rounded and reaching 8 past the row's content without moving it. */
export const rowHover = (fill: string) =>
  ({ backgroundColor: fill, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: radius.control, borderCurve: "continuous" }) as const;
