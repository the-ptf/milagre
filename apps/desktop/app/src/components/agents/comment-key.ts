import { useEffect, useEffectEvent } from "react";
import { isModalOpen } from "../../lib/modal";

export const COMMENT_KEY = "C";

function isCommentKey(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== COMMENT_KEY.toLowerCase() || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return false;
  if (document.activeElement instanceof HTMLIFrameElement) return false;
  if (document.documentElement.hasAttribute("data-popover-open")) return false;
  return !isModalOpen() && !document.querySelector("[data-slot=design-page-share]");
}

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
