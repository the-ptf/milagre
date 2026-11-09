/**
 * Whether a panel's edge is being dragged (the sidebar's, a side panel's). Work that a resize sets off but that only
 * needs the final width (rebuilding the chat's message rail, fitting the design canvas, measuring a docked simulator)
 * waits for the drag to end instead of running on every frame of it.
 */
let dragging = false;
const ended = new Set<() => void>();

export const panelResizing = () => dragging;

export function setPanelResizing(value: boolean) {
  if (dragging === value) return;
  dragging = value;
  // A copy: resize callbacks can unsubscribe and resubscribe while they run.
  if (!value) for (const listener of Array.from(ended)) listener();
}

/** Runs `listener` each time a drag ends. Returns the unsubscribe. */
export function onPanelResizeEnd(listener: () => void) {
  ended.add(listener);
  return () => {
    ended.delete(listener);
  };
}
