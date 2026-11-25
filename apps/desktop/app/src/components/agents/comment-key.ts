import { useEffect, useEffectEvent } from "react";
import { isModalOpen } from "../../lib/modal";

export const COMMENT_KEY = "C";

/** A bare letter press meant for the canvas: not typed into a field or a design, and with no dialog or menu open. */
function isCanvasKey(event: KeyboardEvent, key: string) {
  if (event.key.toLowerCase() !== key.toLowerCase() || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return false;
  if (document.activeElement instanceof HTMLIFrameElement) return false;
  if (document.documentElement.hasAttribute("data-popover-open")) return false;
  return !isModalOpen() && !document.querySelector("[data-slot=design-page-share]");
}

export function useCanvasKeys(enabled: boolean, keys: Record<string, () => void>) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const run = Object.entries(keys).find(([name]) => isCanvasKey(event, name))?.[1];
    if (!run) return;
    event.preventDefault();
    run();
  });
  useEffect(() => {
    if (!enabled) return;
    const handle = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [enabled]);
}

export function useCommentKey(enabled: boolean, toggle: () => void) {
  useCanvasKeys(enabled, { [COMMENT_KEY]: toggle });
}
