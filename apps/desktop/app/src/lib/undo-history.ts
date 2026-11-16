export { undoHistory, type ToastKind, type UndoAction, type UndoToast } from "@milagre/shared/undo-history";

export function undoKey(event: KeyboardEvent, mac: boolean): "undo" | "redo" | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.key.toLowerCase() !== "z") return null;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  const target = event.target;
  if (typeof Element !== "undefined" && target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])"))
    return null;
  return event.shiftKey ? "redo" : "undo";
}
