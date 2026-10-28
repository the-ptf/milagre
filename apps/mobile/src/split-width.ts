/** How wide the window is: the phone stack, a sidebar that slides over as a card, or a sidebar pinned beside the Chat. */
export type WidthClass = "compact" | "regular" | "wide";

/** Below this (an iPhone, iPad Split View or Slide Over, a narrow Stage Manager window) the app is the phone stack. */
const REGULAR_WIDTH = 700;
/** From here (iPad landscape) the sidebar stays pinned beside the Chat; between the two it slides over as a card. */
const WIDE_WIDTH = 1080;
export const SIDEBAR_WIDTH = 320;
/** The gap around a card: the pinned sidebar, the sidebar sliding over and Changes. */
export const CARD_MARGIN = 12;
/** The toolbar row at the top of a resizable iPad window, which holds its window controls. */
const CONTROLS_ROW = 44;
/** The right panel (Changes, a PR, a simulator, designs) is a card this wide, docked beside the Chat or sliding over it. */
export const CHANGES_WIDTH = 420;
/** The room the docked right panel takes beside the Chat: its card and the gap to its right. */
export const DOCK_SLOT = CHANGES_WIDTH + CARD_MARGIN;
/** The narrowest Chat the docked right panel leaves; a narrower window slides the panel over the Chat instead. */
const MIN_DOCKED_CHAT = 360;
/** The Chat keeps this much between the pinned sidebar and the docked right panel; with less, the sidebar gives way. */
const MIN_CHAT_BETWEEN = 500;
/** The transcript and composer keep to this reading column on a wide Chat, centered as on desktop. */
export const READING_WIDTH = 760;

export function widthClass(width: number): WidthClass {
  return width >= WIDE_WIDTH ? "wide" : width >= REGULAR_WIDTH ? "regular" : "compact";
}

/** Whether the right panel docks beside the Chat, pushing it over, or slides over it (a phone, a narrow window). */
export function rightDocks(width: number) {
  return widthClass(width) !== "compact" && width - DOCK_SLOT >= MIN_DOCKED_CHAT;
}

/** Whether the pinned sidebar still leaves the Chat room with the right panel docked too, as desktop makes room. */
export function sidebarFits(width: number, docked: boolean) {
  return !docked || width - SIDEBAR_WIDTH - CARD_MARGIN - DOCK_SLOT >= MIN_CHAT_BETWEEN;
}

/** The Chat's width once the pinned sidebar takes its share. */
export function chatAreaWidth(width: number, pinned: boolean) {
  return pinned ? width - SIDEBAR_WIDTH - CARD_MARGIN : width;
}

/**
 * A card reaches as close to the top as it does to the bottom: just under the status bar, or a margin from the edge.
 * In a resizable window its content keeps below the window controls, which sit over the card's top-left corner.
 */
export function cardTop(safeTop: number, windowed: boolean) {
  const top = Math.max(safeTop, CARD_MARGIN);
  return { top, controls: windowed ? Math.max(0, CONTROLS_ROW - top) : 0 };
}
