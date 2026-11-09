export type MorphRect = { x: number; y: number; width: number; height: number; radius: number };
type Box = { x: number; y: number; width: number; height: number };

/**
 * The Tasks panel's room: the composer column's own side padding, a gap under the header, at most this share of the
 * window above the keyboard, and its corner radius.
 */
export const PLAN_PANEL = { edge: 12, top: 52, share: 0.7, radius: 20 } as const;

/**
 * Where the Tasks pill's surface starts and ends, relative to the overlay it is drawn in. It grows from the pill to the
 * full width of the composer's column (`room`, the whole window when unmeasured), keeping the pill's bottom edge, and is
 * as tall as its content up to 70% of the window above the keyboard and never above the header. Window coordinates in,
 * overlay coordinates out.
 */
export function planPanelFrame({
  window,
  insets,
  pill,
  room = { x: 0, width: window.width },
  content,
  keyboard = 0,
  origin = { x: 0, y: 0 },
}: {
  window: { width: number; height: number };
  insets: { top: number; left: number; right: number };
  pill: Box;
  room?: { x: number; width: number };
  content: number;
  keyboard?: number;
  origin?: { x: number; y: number };
}): { from: MorphRect; to: MorphRect } {
  const bottom = pill.y + pill.height;
  // An iPad's pinned sidebar or docked panel sits beside the column; the safe area still bounds a landscape phone's.
  const left = Math.max(room.x, insets.left) + PLAN_PANEL.edge;
  const right = Math.min(room.x + room.width, window.width - insets.right) - PLAN_PANEL.edge;
  const width = Math.max(pill.width, right - left);
  const cap = Math.min(Math.round((window.height - keyboard) * PLAN_PANEL.share), bottom - insets.top - PLAN_PANEL.top);
  const height = Math.max(pill.height, Math.min(content, cap));
  return {
    from: { x: pill.x - origin.x, y: pill.y - origin.y, width: pill.width, height: pill.height, radius: pill.height / 2 },
    to: { x: left - origin.x, y: bottom - height - origin.y, width, height, radius: PLAN_PANEL.radius },
  };
}

/** The surface part way through the morph: 0 is the pill, 1 the panel. Runs on the UI thread. */
export function morphRect(from: MorphRect, to: MorphRect, progress: number): MorphRect {
  "worklet";
  const mix = (a: number, b: number) => a + (b - a) * progress;
  return {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    width: mix(from.width, to.width),
    height: mix(from.height, to.height),
    radius: mix(from.radius, to.radius),
  };
}
