import { type HTMLAttributes, type Ref, useImperativeHandle, useRef } from "react";
import { useScrollFade } from "../../lib/use-scroll-fade";

/**
 * The scrollbar is an overlay: styles.css shows its thumb only on hover or while its element carries data-scrolling.
 * One capture listener marks whichever element scrolls (a ScrollArea, the diff view, the transcript) for 800ms after
 * each scroll event, so a wheel or trackpad flick shows the thumb, then lets it go.
 */
const SCROLLING_MS = 800;
const scrollingTimers = new WeakMap<Element, number>();
function markScrolling(event: Event) {
  const target = event.target instanceof Element ? event.target : document.scrollingElement;
  if (!target) return;
  target.setAttribute("data-scrolling", "");
  window.clearTimeout(scrollingTimers.get(target));
  scrollingTimers.set(
    target,
    window.setTimeout(() => target.removeAttribute("data-scrolling"), SCROLLING_MS),
  );
}
if (typeof document !== "undefined") document.addEventListener("scroll", markScrolling, { capture: true, passive: true });

/**
 * The app's scroll container: vertical scroll that stays inside it, the shared thin scrollbar from styles.css, and
 * edge fades that show only while there's more to scroll that way. Every scrolling list or panel uses this instead
 * of wiring overflow, overscroll and useScrollFade by hand. Cap its height through the parent (a max-height flex
 * column) or a class. Inside another scroller (tool output in the transcript), pass `chainScroll` so the wheel moves
 * on to the outer one once this one reaches its end.
 */
export function ScrollArea({
  as: Tag = "div",
  ref,
  chainScroll = false,
  horizontal = false,
  className = "",
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "div" | "ul" | "ol";
  ref?: Ref<HTMLElement>;
  chainScroll?: boolean;
  horizontal?: boolean;
}) {
  const inner = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLElement, []);
  useScrollFade(inner);
  return (
    <Tag
      ref={inner as Ref<never>}
      className={`scroll-fade min-h-0 ${horizontal ? "overflow-x-auto overflow-y-hidden" : "overflow-y-auto"} ${chainScroll ? "" : "overscroll-contain"} ${className}`}
      {...props}
    />
  );
}
