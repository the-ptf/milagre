import { forwardRef, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { motion, useMotionValue, useMotionValueEvent, usePresence, useReducedMotion, animate } from "motion/react";
import { EASE_OUT, SPRING_LAYOUT } from "../../lib/ease";

// Slides can share one reserve: the designs closing while the artifacts open in their place, each sliding at its own
// width. The chat keeps room for the widest one still there, and the last one to go gives it back; otherwise the one
// that finished sliding last would set the room alone, and a closing panel would take it from the opening one.
const rooms = new Map<string, Map<symbol, number>>();
function setRoom(reserve: string, slide: symbol, room: number | null) {
  const slides = rooms.get(reserve) ?? new Map<symbol, number>();
  if (room === null) slides.delete(slide);
  else slides.set(slide, room);
  if (slides.size) rooms.set(reserve, slides);
  else rooms.delete(reserve);
  const widest = Math.max(0, ...slides.values());
  if (widest > 0) document.documentElement.style.setProperty(reserve, `${widest}px`);
  else document.documentElement.style.removeProperty(reserve);
}

/**
 * A panel docked at the window's right, entering the way the git changes panel does: its width springs open from
 * zero, the chat making room as it grows (through `reserve`, the CSS variable the chat panes read), and its content
 * slides in from the right as it fades in. Closing (under AnimatePresence) runs it backwards, from wherever it is. `width` null lays it out
 * by its own `style` instead (a panel filling the workspace), which only fades. While `resizing`, its width follows the
 * drag without the spring; `handle`, the ResizeHandle on its left edge, sits outside the card so the card's clip keeps
 * it whole.
 */
export const DockSlide = forwardRef<
  HTMLDivElement,
  {
    width: number | null;
    reserve: string;
    style: CSSProperties;
    /** Where it sits (position, z-index): the slot that opens and closes. */
    className: string;
    /** What it looks like (surface, border, radius, shadow): the card that slides through the slot. */
    panelClassName: string;
    children: ReactNode;
    onEntered?: () => void;
    resizing?: boolean;
    handle?: ReactNode;
  } & Omit<React.HTMLAttributes<HTMLDivElement>, "style" | "className" | "children">
>(function DockSlide({ width, reserve, style, className, panelClassName, children, onEntered, resizing = false, handle, ...rest }, ref) {
  const reduced = useReducedMotion();
  const shown = useMotionValue(reduced || width === null ? (width ?? 0) : 0);
  const [sliding, setSliding] = useState(!reduced && width !== null);
  const [slide] = useState(() => Symbol(reserve));
  // The chat's room follows the panel's width as it springs, as it follows the changes panel's.
  useMotionValueEvent(shown, "change", (value) => {
    if (width !== null) setRoom(reserve, slide, value > 0.5 ? value + 12 : 0);
  });
  // Opening and closing are one spring of the width, to the panel's width or to zero: closed again while it opens, or
  // opened again while it closes, it turns around from where it is. Closing ends by letting AnimatePresence remove it.
  const [isPresent, safeToRemove] = usePresence();
  useEffect(() => {
    const done = () => {
      if (isPresent) return;
      setRoom(reserve, slide, null);
      safeToRemove?.();
    };
    if (width === null) {
      setRoom(reserve, slide, null);
      if (isPresent) return;
      // Filling the workspace, it only fades (the content's exit), then goes.
      const timer = window.setTimeout(done, reduced ? 0 : 180);
      return () => window.clearTimeout(timer);
    }
    // Dragged, the width follows the pointer. A drag ending where the width already is springs nowhere: the spring
    // would start from the drag's velocity and wobble past it.
    if (reduced || (isPresent && (resizing || Math.abs(shown.get() - width) < 0.5))) {
      shown.set(isPresent ? width : 0);
      if (isPresent) setRoom(reserve, slide, width + 12);
      done();
      return;
    }
    // The room is set from where the width is now: springing to the width it already has (back from filling the
    // workspace) changes nothing, and so would never set it.
    if (shown.get() > 0.5) setRoom(reserve, slide, shown.get() + 12);
    setSliding(true);
    const controls = animate(shown, isPresent ? width : 0, {
      ...SPRING_LAYOUT,
      onComplete: () => {
        setSliding(false);
        done();
      },
    });
    return () => controls.stop();
  }, [width, reduced, resizing, reserve, slide, shown, isPresent, safeToRemove]);
  useEffect(
    () => () => {
      setRoom(reserve, slide, null);
    },
    [reserve, slide],
  );
  return (
    <motion.div
      ref={ref}
      {...(rest as object)}
      // Laid out by its own style, the width it sprang to must go too, or it would outrank `right`.
      style={width === null ? { ...style, width: "auto" } : { ...style, width: shown }}
      // Clipped only while the width moves: clipped at rest it would cut the panel's shadow.
      // An invisible slot, like the changes panel's: as it narrows, its left edge moves right over the card, which keeps
      // its width and so slides out to the window's edge instead of shrinking. Clipped only while the width moves.
      className={`${className} flex ${sliding ? "overflow-hidden" : ""}`}
    >
      <motion.div
        className={`flex min-h-0 flex-1 flex-col ${panelClassName}`}
        style={width === null ? undefined : { width, minWidth: width }}
        initial={reduced ? false : { opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={reduced ? undefined : { opacity: 0, x: 24 }}
        transition={reduced ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }}
        onAnimationComplete={onEntered}
      >
        {children}
      </motion.div>
      {width !== null && handle}
    </motion.div>
  );
});
