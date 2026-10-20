import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, usePresence } from "motion/react";
import { SPRING_LAYOUT, scaled, scaledSpring, useMotionScale } from "../../lib/ease";

// The gap between the Chat and the panel, part of the room that opens.
const GAP = 8;

/**
 * The Terminals panel rising from the window's bottom edge, the way the changes panel opens from the right: the slot's
 * height springs from zero, the Chat making room as it grows, and the card rises through it as it fades in. Closing
 * (under AnimatePresence) runs it backwards from wherever it is. The card keeps the height it ends at (or has) while
 * the slot moves, so the Terminal is fitted once instead of on every frame and the shell isn't sent a resize per frame.
 */
export function TerminalSlide({ height, children }: { height: number; children: ReactNode }) {
  const scale = useMotionScale();
  const reduced = scale === 0;
  const slot = useRef<HTMLDivElement>(null);
  const shown = useMotionValue(0);
  // The card's height in pixels while the slot moves; null at rest, where it fills the slot.
  const [card, setCard] = useState<number | null>(reduced ? null : height);
  const sliding = useRef(false);
  const latestHeight = useRef(height);
  useLayoutEffect(() => {
    latestHeight.current = height;
  });
  // A plain div follows the spring by hand: a motion.div given a motion value for `height` keeps it, and would ignore
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
    // Fractional, as CSS laid it out: a rounded height would refit the Terminal by a pixel as it starts to close.
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
      // The card hangs from the slot's top edge and runs past the window's bottom, clipped there, so it rises with the
      // edge, tabs first. Clipped only while it moves: at rest the clip would cut the resize handle above the card.
      className={`flex shrink-0 flex-col ${moving ? "overflow-hidden" : ""}`}
      style={{ paddingTop: GAP, height: moving ? `${shown.get()}px` : `calc(min(${height}px, 75%) + ${GAP}px)` }}
    >
      <motion.div
        className="flex min-h-0 flex-col"
        style={moving ? { height: card, flexShrink: 0 } : { flex: "1 1 0%" }}
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: isPresent ? 1 : 0 }}
        transition={reduced ? { duration: 0 } : { duration: scaled(isPresent ? 0.24 : 0.16, scale) }}
      >
        {children}
      </motion.div>
    </div>
  );
}
