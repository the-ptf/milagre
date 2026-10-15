import { useEffect, useEffectEvent } from "react";
import { isModalOpen } from "../../lib/modal";

/** The key that turns comment mode on and off on the Designs canvas, pressed on its own. */
export const COMMENT_KEY = "C";

/** Whether a key press is the comment key, pressed where it means nothing else: not while typing, nor over a dialog or menu. */
function isCommentKey(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== COMMENT_KEY.toLowerCase() || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return false;
  // A design that has the focus (its frame) keeps its keys; so do an open menu and a modal (a dialog, the design editor).
  if (document.activeElement instanceof HTMLIFrameElement) return false;
  if (document.documentElement.hasAttribute("data-popover-open")) return false;
  return !isModalOpen() && !document.querySelector("[data-slot=design-page-share]");
}

/** Calls `toggle` when the comment key is pressed, while `enabled`. */
export function useCommentKey(enabled: boolean, toggle: () => void) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!isCommentKey(event)) return;
    event.preventDefault();
    toggle();
  });
  useEffect(() => {
    if (!enabled) return;
    const handle = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [enabled]);
}
