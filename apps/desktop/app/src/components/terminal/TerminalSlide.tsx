import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, usePresence } from "motion/react";
import { DURATION, SPRING_LAYOUT, scaled, scaledSpring, useMotionScale } from "../../lib/ease";
import { saveTerminalHeight, setTerminalHeight, TERMINAL_HEIGHT } from "../../lib/terminal-store";

const GAP = 8;

/** `instant` (a Workspace tab bringing the Terminal forward or away) shows and hides it without the slide. */
export function TerminalSlide({ height, instant = false, children }: { height: number; instant?: boolean; children: ReactNode }) {
  const scale = useMotionScale();
  const reduced = scale === 0 || instant;
  const slot = useRef<HTMLDivElement>(null);
  const shown = useMotionValue(0);
  const [card, setCard] = useState<number | null>(reduced ? null : height);
  const sliding = useRef(false);
  const latestHeight = useRef(height);
  useLayoutEffect(() => {
    latestHeight.current = height;
  });
  // the CSS height the panel goes back to at rest, so dragging the divider would no longer size it.
  useMotionValueEvent(shown, "change", (value) => {
    if (sliding.current && slot.current) slot.current.style.height = `${value}px`;
  });
  const [isPresent, safeToRemove] = usePresence();
  useLayoutEffect(() => {
    const element = slot.current;
    if (!element) return;
    if (reduced) {
      if (!isPresent) safeToRemove?.();
      return;
    }
    if (!isPresent && element.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const room = (element.parentElement?.clientHeight ?? window.innerHeight) * 0.75;
    // Fractional, as CSS laid it out: a rounded-control height would refit the Terminal by a pixel as it starts to close.
    const resting = element.getBoundingClientRect().height;
    const cardHeight = isPresent ? Math.min(latestHeight.current, room) : resting - GAP;
    // At rest the slot is laid out by CSS: start from the height it has (turned around mid-slide, it is already there).
    if (!sliding.current) shown.set(isPresent ? 0 : resting);
    sliding.current = true;
    setCard(cardHeight);
    const controls = animate(shown, isPresent ? cardHeight + GAP : 0, {
      ...scaledSpring(SPRING_LAYOUT, scale),
      onComplete: () => {
        sliding.current = false;
        if (isPresent) setCard(null);
        else safeToRemove?.();
      },
    });
    return () => controls.stop();
  }, [isPresent, reduced, scale, shown, safeToRemove]);

  const moving = !reduced && card !== null;
  return (
    <div
      ref={slot}
      data-terminal-slot
      data-sliding={moving || undefined}
      className={`flex shrink-0 flex-col ${moving ? "overflow-hidden" : ""}`}
      style={{ paddingTop: GAP, height: moving ? `${shown.get()}px` : `calc(min(${height}px, 75%) + ${GAP}px)` }}
    >
      <motion.div
        className="flex min-h-0 flex-col"
        style={moving ? { height: card, flexShrink: 0 } : { flex: "1 1 0%" }}
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: isPresent ? 1 : 0 }}
        transition={reduced ? { duration: 0 } : { duration: scaled(isPresent ? DURATION.slow : DURATION.base, scale) }}
      >
        {children}
      </motion.div>
    </div>
  );
}

/** Dragging the Terminals' top edge: the panel grows up to three quarters of the Chat pane, and the height is kept. */
export function startTerminalResize(event: React.PointerEvent, panel: HTMLElement | null, height: number) {
  event.preventDefault();
  const startY = event.clientY;
  const startHeight = panel?.getBoundingClientRect().height ?? height;
  const room = (panel?.closest("[data-terminal-slot]")?.parentElement?.getBoundingClientRect().height ?? window.innerHeight) * 0.75;
  const move = (next: PointerEvent) => setTerminalHeight(Math.min(room, Math.max(TERMINAL_HEIGHT.min, startHeight + startY - next.clientY)));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.documentElement.style.cursor = "";
    saveTerminalHeight();
  };
  document.documentElement.style.cursor = "row-resize";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
