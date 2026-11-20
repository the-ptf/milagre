export type DesignMode = "light" | "dark" | "contrast";
export const DESIGN_MODES: DesignMode[];
export const DESIGN_MODE_LABELS: Record<DesignMode, string>;
/** The modes a layer design's color tokens define, light first. */
export function designModesOf(document: { tokens?: Record<string, unknown>; kit?: { colors?: Record<string, unknown> } } | null | undefined): DesignMode[];
/** A saved layer design's HTML switched to a mode. */
export function designHtmlForMode(html: string, mode: DesignMode | null | undefined): string;
