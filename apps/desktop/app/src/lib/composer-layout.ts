/** The compact prompt's height for one line: 18px of text and 5px of padding above and below. */
export const COMPACT_LINE_HEIGHT = 28;

/** A draft the compact layout, on screen, showed wrapping at this prompt width. */
export type CompactOverflow = { draft: string; width: number } | null;

export interface ComposerLayoutInput {
  draft: string;
  expanded: boolean;
  alwaysExpanded: boolean;
  /** The prompt's scrollHeight in the layout on screen. */
  contentHeight: number;
  /** The prompt's width the last time the compact layout was on screen; 0 before it ever was. */
  compactWidth: number;
  /** What the last compact layout showed, kept between calls. */
  overflow: CompactOverflow;
  /** The draft's width in the compact font, estimated without laying it out, or null when it can't be. */
  measure: (draft: string) => number | null;
}

/**
 * Whether the composer takes its tall layout. The compact layout decides by laying the draft out; the tall one can
 * only estimate whether the draft would fit on one line again. The estimate leaves out letter-spacing, font features
 * and line-breaking rules, so it can say a draft fits that the compact layout just wrapped. Acting on it then switched
 * layouts on every commit until React stopped at its nested-update limit and unmounted the window. So the estimate
 * never overrules the compact layout: a draft it wrapped, or a longer one, stays tall until the prompt gets wider.
 */
export function composerLayout(input: ComposerLayoutInput): { expanded: boolean; overflow: CompactOverflow } {
  const { draft, expanded, alwaysExpanded, contentHeight, compactWidth, overflow, measure } = input;
  if (alwaysExpanded || draft.includes("\n")) return { expanded: true, overflow };
  if (!expanded) {
    // An empty draft never expands: the expanded branch collapses it again, so a placeholder that wraps
    // in a narrow composer would flip the layout forever.
    const wraps = draft.length > 0 && contentHeight > COMPACT_LINE_HEIGHT;
    return { expanded: wraps, overflow: wraps ? { draft, width: compactWidth } : null };
  }
  if (draft.length === 0) return { expanded: false, overflow: null };
  // Measure only short drafts when deciding whether the compact layout fits again.
  if (draft.length > 200 || !compactWidth) return { expanded: true, overflow };
  if (overflow && draft.startsWith(overflow.draft) && compactWidth <= overflow.width) return { expanded: true, overflow };
  const width = measure(draft);
  return { expanded: width !== null && width + 8 > compactWidth, overflow };
}
