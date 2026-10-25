/** How wide the window is: the phone stack, a sidebar that slides over as a card, or a sidebar pinned beside the Chat. */
export type WidthClass = "compact" | "regular" | "wide";

/** Below this (an iPhone, iPad Split View or Slide Over, a narrow Stage Manager window) the app is the phone stack. */
const REGULAR_WIDTH = 700;
/** From here (iPad landscape) the sidebar stays pinned beside the Chat; between the two it slides over as a card. */
const WIDE_WIDTH = 1080;
export const SIDEBAR_WIDTH = 320;
/** The gap around a card: the pinned sidebar, the sidebar sliding over and Changes. */
export const CARD_MARGIN = 12;
/**
 * A card starts below the toolbar row, as desktop's sidebar starts below its title bar. In a resizable iPad window that
 * row also holds the window controls, which would otherwise cover the card's title.
 */
export const CARD_TOP = 44;
/** Changes slides over from the right as a card this wide. */
export const CHANGES_WIDTH = 420;
/** The transcript and composer keep to this reading column on a wide Chat, centered as on desktop. */
const READING_WIDTH = 760;

export function widthClass(width: number): WidthClass {
  return width >= WIDE_WIDTH ? "wide" : width >= REGULAR_WIDTH ? "regular" : "compact";
}

/** The Chat's width once the pinned sidebar takes its share. */
export function chatAreaWidth(width: number, pinned: boolean) {
  return pinned ? width - SIDEBAR_WIDTH - CARD_MARGIN : width;
}

/** The extra side padding that centers a reading column in `area`; none where the column doesn't fit. */
export function readingInset(area: number, column = READING_WIDTH) {
  return Math.max(0, Math.round((area - column) / 2));
}
