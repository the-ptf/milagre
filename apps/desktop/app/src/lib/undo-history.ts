/**
 * The desktop's one undo history (the shared one, @milagre/shared/undo-history), shown by the sidebar's toast, and the
 * keys that walk it.
 */
export { undoHistory, type ToastKind, type UndoAction, type UndoToast } from "@milagre/shared/undo-history";

/**
 * ⌘Z / ⇧⌘Z (Ctrl on other systems) meant for the history: not typed into a field and not taken by an editor. The caller
 * also leaves it alone while a modal or popover is open (lib/modal.ts).
 */
export function undoKey(event: KeyboardEvent, mac: boolean): "undo" | "redo" | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.key.toLowerCase() !== "z") return null;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  const target = event.target;
  if (typeof Element !== "undefined" && target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])"))
    return null;
  return event.shiftKey ? "redo" : "undo";
}
