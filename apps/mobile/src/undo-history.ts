import { useEffect, useSyncExternalStore } from "react";
import { Delete02Icon, Tick02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { DELETE_UNDO_MS } from "@milagre/shared/archive";
import { undoHistory, type ToastKind } from "@milagre/shared/undo-history";

/**
 * The phone's undo history is the shared one (desktop's too): the Chat list's Done, Reopen and pins, deletions
 * (archive.ts), and Done on the Chat screen. Each toast's Undo and Redo walk it, and an iPad's ⌘Z / ⇧⌘Z while the toast
 * shows.
 */
export { undoHistory };

const ICONS: Record<ToastKind, typeof Tick02Icon> = { done: Tick02Icon, deleted: Delete02Icon, undone: Undo02Icon };

/**
 * The history's toast for one screen (`place`), as ToastPill props, or null when it shows elsewhere or nothing: the step
 * just taken with Undo, and after an Undo what it went back to with Redo. Long enough to read and reach with a thumb; a
 * deletion's only lasts its Undo window.
 */
export function useHistoryToast(place: string) {
  const toast = useSyncExternalStore(undoHistory.subscribe, undoHistory.toast);
  const shown = toast?.place === place ? toast : null;
  useEffect(() => {
    if (!shown) return;
    const ms = !shown.button ? 3000 : shown.kind === "deleted" ? DELETE_UNDO_MS : 10000;
    const timer = setTimeout(() => undoHistory.dismiss(shown.id), ms);
    return () => clearTimeout(timer);
  }, [shown]);
  if (!shown) return null;
  return {
    id: shown.id,
    text: shown.text,
    icon: shown.kind && ICONS[shown.kind],
    badge: shown.kind === "done",
    action:
      shown.button === "undo"
        ? { label: "Undo", onPress: () => void undoHistory.undo() }
        : shown.button === "redo"
          ? { label: "Redo", onPress: () => void undoHistory.redo() }
          : undefined,
  };
}
