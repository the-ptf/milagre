export type WidthClass = "compact" | "regular" | "wide";

/** Below this (an iPhone, iPad Split View or Slide Over, a narrow Stage Manager window) the app is the phone stack. */
const REGULAR_WIDTH = 700;
/** From here (iPad landscape) the sidebar stays pinned beside the Chat; between the two it slides over as a card. */
const WIDE_WIDTH = 1080;
export const SIDEBAR_WIDTH = 320;
export const CARD_MARGIN = 12;
/** The toolbar row at the top of a resizable iPad window, which holds its window controls. */
const CONTROLS_ROW = 44;
/** The right panel (Changes, a PR, a simulator, designs) is a card this wide, docked beside the Chat or sliding over it. */
export const CHANGES_WIDTH = 420;
export const PANEL_MIN_WIDTH = 320;
export const DOCK_GUTTER = 12;
function dockSlot(panelWidth: number) {
  return DOCK_GUTTER + panelWidth + CARD_MARGIN;
}
const MIN_DOCKED_CHAT = 360;
const MIN_CHAT_BETWEEN = 500;
export const READING_WIDTH = 760;

export function widthClass(width: number): WidthClass {
  return width >= WIDE_WIDTH ? "wide" : width >= REGULAR_WIDTH ? "regular" : "compact";
}

export function rightDocks(width: number) {
  return widthClass(width) !== "compact" && width - dockSlot(CHANGES_WIDTH) >= MIN_DOCKED_CHAT;
}

export function sidebarFits(width: number, docked: boolean, panelWidth = CHANGES_WIDTH) {
  return !docked || width - SIDEBAR_WIDTH - CARD_MARGIN - dockSlot(panelWidth) >= MIN_CHAT_BETWEEN;
}

export function clampPanelWidth(width: number, panelWidth: number) {
  const max = Math.max(PANEL_MIN_WIDTH, width - MIN_DOCKED_CHAT - DOCK_GUTTER - CARD_MARGIN);
  return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, panelWidth)));
}

export function chatAreaWidth(width: number, pinned: boolean) {
  return pinned ? width - SIDEBAR_WIDTH - CARD_MARGIN : width;
}

export function cardTop(safeTop: number, windowed: boolean) {
  const top = Math.max(safeTop, CARD_MARGIN);
  return { top, controls: windowed ? Math.max(0, CONTROLS_ROW - top) : 0 };
}
