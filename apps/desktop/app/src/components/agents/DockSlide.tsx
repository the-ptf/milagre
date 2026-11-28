import { forwardRef, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PresenceContext, motion, useMotionValue, useMotionValueEvent, usePresence, animate } from "motion/react";
import { chatSwitching } from "../../lib/chat-switch-timing";
import { DURATION, EASE_OUT, SPRING_LAYOUT, scaled, scaledSpring, useMotionScale } from "../../lib/ease";
import { ResizeHandle } from "../primitives/ResizeHandle";
import { dockLayer } from "./dock-area";
import { roomToWiden, usePanelWidth, type ResizablePanel } from "./panel-width";

const rooms = new Map<string, Map<symbol, number>>();
const written = new WeakMap<HTMLElement, Map<string, string>>();
function setRoom(reserve: string, slide: symbol, room: number | null) {
  const slides = rooms.get(reserve) ?? new Map<symbol, number>();
  if (room === null) slides.delete(slide);
  else slides.set(slide, room);
  if (slides.size) rooms.set(reserve, slides);
  else rooms.delete(reserve);
  const widest = Math.max(0, ...slides.values());
  const value = widest > 0 ? `${widest}px` : "";
  const layer = dockLayer();
  const values = written.get(layer) ?? new Map<string, string>();
  written.set(layer, values);
  if ((values.get(reserve) ?? "") === value) return;
  values.set(reserve, value);
  if (value) layer.style.setProperty(reserve, value);
  else layer.style.removeProperty(reserve);
}

/**
 * A panel docked at the window's right, entering the way the git changes panel does: its width springs open from
 * zero, the chat making room as it grows (through `reserve`, the CSS variable the chat panes read), and its content
 * slides in from the right as it fades in. Closing (under AnimatePresence) runs it backwards, from wherever it is. A panel
 * that opens or closes because another Chat came on screen (its Chat had it open, or the new one doesn't) does it at once:
 * a spring would change the chat's width on every frame of the switch. It knows by its presence (already in an
 * `AnimatePresence initial={false}` as that mounts, as the Browser panel's, made anew for each Chat) or by the switch
 * under way (chatSwitching). `width` null lays it out
 * by its own `style` instead (a panel filling the workspace), which only fades. While `resizing`, its width follows the
 * drag without the spring; `handle`, the ResizeHandle on its left edge, sits outside the card so the card's clip keeps
 * it whole. `instant` (a Workspace tab bringing it forward or away) shows and hides it at once, without the slide or fade.
 */
export const DockSlide = forwardRef<
  HTMLDivElement,
  {
    width: number | null;
    reserve: string;
    style: CSSProperties;
    /** Where it sits (position, z-index): the slot that opens and closes. */
    className: string;
    panelClassName: string;
    children: ReactNode;
    onEntered?: () => void;
    resizing?: boolean;
    handle?: ReactNode;
    instant?: boolean;
  } & Omit<React.HTMLAttributes<HTMLDivElement>, "style" | "className" | "children">
>(function DockSlide({ width, reserve, style, className, panelClassName, children, onEntered, resizing = false, handle, instant = false, ...rest }, ref) {
  const scale = useMotionScale();
  const reduced = scale === 0 || instant;
  const presence = useContext(PresenceContext);
  const [landed] = useState(() => reduced || presence?.initial === false || (width !== null && chatSwitching()));
  const shown = useMotionValue(landed || width === null ? (width ?? 0) : 0);
  const [sliding, setSliding] = useState(!landed && width !== null);
  const [slide] = useState(() => Symbol(reserve));
  const springing = useRef(!landed && width !== null);
  useMotionValueEvent(shown, "change", (value) => {
    if (width !== null) setRoom(reserve, slide, value > 0.5 ? value + 12 : 0);
  });
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
      if (reduced) return done();
      const timer = window.setTimeout(done, scaled(180, scale));
      return () => window.clearTimeout(timer);
    }
    // other change lands at once: a drag, its end, a key, the window narrowing. A spring there would trail the pointer
    const leavingWithChat = !isPresent && chatSwitching();
    if (reduced || leavingWithChat || (isPresent && (resizing || (!springing.current && shown.get() > 0.5)))) {
      springing.current = false;
      shown.set(isPresent ? width : 0);
      if (isPresent) setRoom(reserve, slide, width + 12);
      setSliding(leavingWithChat);
      done();
      return;
    }
    if (shown.get() > 0.5) setRoom(reserve, slide, shown.get() + 12);
    springing.current = true;
    setSliding(true);
    const controls = animate(shown, isPresent ? width : 0, {
      ...scaledSpring(SPRING_LAYOUT, scale),
      onComplete: () => {
        springing.current = false;
        setSliding(false);
        done();
      },
    });
    return () => controls.stop();
  }, [width, reduced, scale, resizing, reserve, slide, shown, isPresent, safeToRemove]);
  useEffect(
    () => () => {
      setRoom(reserve, slide, null);
    },
    [reserve, slide],
  );
  useEffect(() => {
    if (landed && !reduced) onEntered?.();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, when it mounts already open
  }, []);
  return (
    <motion.div
      ref={ref}
      {...(rest as object)}
      style={width === null ? { ...style, width: "auto" } : { ...style, width: shown }}
      className={`${className} flex ${sliding ? "overflow-hidden" : ""}`}
    >
      <motion.div
        className={`flex min-h-0 flex-1 flex-col ${panelClassName}`}
        style={width === null ? undefined : { width, minWidth: width }}
        initial={landed ? false : { opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={reduced ? undefined : { opacity: 0, x: 24 }}
        transition={{ duration: scaled(DURATION.slow, scale), ease: EASE_OUT }}
        onAnimationComplete={onEntered}
      >
        {children}
      </motion.div>
      {width !== null && handle}
    </motion.div>
  );
});

export const ResizableDockSlide = forwardRef<
  HTMLDivElement,
  Omit<React.ComponentProps<typeof DockSlide>, "resizing" | "handle" | "ref"> & { panel: ResizablePanel; label: string }
>(function ResizableDockSlide({ panel, label, width, ...rest }, ref) {
  const resize = usePanelWidth(panel);
  const live = width === null ? null : resize.resizing ? resize.width : width;
  return (
    <DockSlide
      ref={ref}
      width={live}
      resizing={resize.resizing}
      handle={
        live !== null && (
          <ResizeHandle
            label={label}
            side="left"
            width={live}
            min={resize.min}
            max={() => roomToWiden(panel, live)}
            reset={resize.reset}
            onResize={resize.onResize}
            onCommit={resize.onCommit}
          />
        )
      }
      {...rest}
    />
  );
});
