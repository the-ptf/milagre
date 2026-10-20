import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import type { DesignPin, PinControls } from "./ArtifactCanvas";
import { EASE_OUT, useMotionScale } from "../../lib/ease";
import { THEME_EVENT } from "../../lib/theme-sheet";
import { useDismiss } from "../../lib/use-dismiss";
import { morphFace, useSize, HIDDEN_FACE } from "../motion/morph";

const SEND_KEYS = /Mac/.test(navigator.userAgent) ? "⌘Enter" : "Ctrl+Enter";

/** A pin's size, in screen pixels: a round bubble whose top-left corner is its point. */
const PIN = 24;
const PIN_RADIUS = `0 ${PIN / 2}px ${PIN / 2}px ${PIN / 2}px`;
const BUBBLE_RADIUS = "3px 10px 10px 10px";
/** The pin and its bubble are one surface: its size, corners, fill and ring move together; reduced motion jumps. */
const SURFACE =
  "transition-[width,height,border-radius,background-color,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0";
/** A white ring keeps a pin readable on light and dark designs alike. */
const PIN_SHADOW = "0 0 0 1.5px #fff, 0 1px 3px rgb(0 0 0 / 0.3)";

/**
 * The comment cursor: the pin's own shape, its point (top-left) on the spot a click pins, in the accent with a white
 * ring. The 2x image keeps it sharp on a Retina screen.
 */
export function commentCursor(fill: string) {
  const svg = (size: number) =>
    `url("data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 22 22"><path d="M2 2H11A9 9 0 0 1 20 11A9 9 0 0 1 11 20A9 9 0 0 1 2 11Z" fill="${fill}" stroke="#fff" stroke-width="1.5" stroke-linejoin="miter"/></svg>`,
    )}")`;
  return `image-set(${svg(22)} 1x, ${svg(44)} 2x) 2 2, crosshair`;
}

/** The comment cursor in the current theme's accent, read again when the theme changes. */
function useCommentCursor(on: boolean) {
  const [theme, setTheme] = useState(0);
  useEffect(() => {
    if (!on) return;
    const changed = () => setTheme((count) => count + 1);
    window.addEventListener(THEME_EVENT, changed);
    return () => window.removeEventListener(THEME_EVENT, changed);
  }, [on]);
  return useMemo(() => {
    if (!on) return undefined;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    return commentCursor(accent || "#007df3");
    // `theme` is only a signal to read the accent again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, theme]);
}

/**
 * The layer over a design that holds its comments. In comment mode it takes the clicks, each pinning a comment at its
 * point (as fractions of the design); otherwise only the pins take the mouse. It sits outside the design's clipping,
 * so a bubble near an edge stays whole.
 */
export function CommentLayer({
  commenting,
  title,
  onPin,
  children,
}: {
  commenting: boolean;
  title: string;
  onPin: (x: number, y: number) => void;
  children: ReactNode;
}) {
  const cursor = useCommentCursor(commenting);
  return (
    <div
      data-slot="artifact-comment-layer"
      data-design-body
      aria-label={commenting ? `Pin a comment on ${title}` : undefined}
      className={`absolute inset-0 ${commenting ? "" : "pointer-events-none"}`}
      style={cursor ? { cursor } : undefined}
      onClick={(event) => {
        if (!commenting || event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        onPin((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
      }}
    >
      {children}
    </div>
  );
}

/**
 * A pinned comment, Figma-like: a numbered pin whose point marks the spot, which grows from that point into the bubble
 * holding the comment, and shrinks back into the pin when it closes. Enter, Escape or a press elsewhere closes the
 * bubble, keeping the comment for Send; ⌘Enter sends it right away with the rest of the feedback; one closed empty is
 * removed. Both stay the same size on screen however far the canvas zooms.
 */
export function CommentPin({
  pin,
  number,
  open,
  scale,
  comments,
  sent = false,
}: {
  pin: DesignPin;
  number: number;
  open: boolean;
  scale: number;
  comments: PinControls;
  /** A comment already sent: its bubble reads it back, and it can't change. */
  sent?: boolean;
}) {
  const reduce = useReducedMotion();
  const motionScale = useMotionScale();
  const root = useRef<HTMLDivElement>(null);
  const [bubble, measureBubble] = useSize();
  // Above the frames beside it while the bubble is open or shrinking back, so it stays whole past its design.
  const [lifted, setLifted] = useState(open);
  if (open && !lifted) setLifted(true);
  const close = () => {
    if (!sent && !pin.text.trim()) comments.onRemove(pin.key);
    comments.onOpen(null);
  };
  // A press anywhere else closes the bubble. Pins stay where they are as the page scrolls, so a scroll doesn't.
  useDismiss(
    open,
    close,
    (target) => !!root.current?.contains(target),
    () => {},
  );
  // Escape closes a sent comment's bubble before it reaches the canvas (a draft's textarea handles its own).
  useEffect(() => {
    if (!open || !sent) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      comments.onOpen(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, sent, comments]);
  const [fill, ink] = pin.resolved !== undefined ? ["bg-green", "text-white"] : sent ? ["bg-ink", "text-surface"] : ["bg-accent", "text-white"];
  return (
    <div
      ref={root}
      data-slot="artifact-comment"
      data-open={open || undefined}
      className={`pointer-events-auto absolute ${lifted ? "z-10" : ""}`}
      style={{
        left: `${pin.x * 100}%`,
        top: `${pin.y * 100}%`,
        transform: `scale(${1 / scale})`,
        transformOrigin: "top left",
      }}
      // A click in the bubble isn't a click on the design to pin another comment.
      onClick={(event) => event.stopPropagation()}
    >
      {/* One surface is the pin and grows into the bubble; the pin's number and the bubble's comment crossfade over it. */}
      <div
        aria-hidden
        data-slot="artifact-comment-surface"
        className={`absolute top-0 left-0 overflow-hidden ${SURFACE} ${open ? "bg-surface" : fill}`}
        style={{
          width: open && bubble ? bubble.width : PIN,
          height: open && bubble ? bubble.height : PIN,
          borderRadius: open ? BUBBLE_RADIUS : PIN_RADIUS,
          boxShadow: open ? "var(--shadow-raised)" : PIN_SHADOW,
        }}
      />
      <motion.button
        type="button"
        data-slot={sent ? "artifact-sent-pin" : "artifact-pin"}
        aria-label={`Comment ${number}${pin.resolved !== undefined ? ", resolved" : ""}${pin.text.trim() ? `: ${pin.text.trim()}` : ""}`}
        aria-expanded={open}
        onClick={() => comments.onOpen(pin.key)}
        {...morphFace(!open, reduce, motionScale)}
        className={`absolute top-0 left-0 grid cursor-pointer place-items-center text-[11px] font-medium ${ink} ${open ? HIDDEN_FACE : "visible"}`}
        style={{ width: PIN, height: PIN, borderRadius: PIN_RADIUS }}
      >
        {number}
      </motion.button>
      <AnimatePresence initial={false} onExitComplete={() => setLifted(false)}>
        {open && (
          <motion.div
            key="bubble"
            ref={measureBubble}
            data-slot="artifact-comment-bubble"
            initial={{ opacity: 0 }}
            // The comment fades in once the surface has mostly grown, and out first as it shrinks back.
            animate={{ opacity: 1, transition: { duration: reduce ? 0 : 0.14, delay: reduce ? 0 : 0.1, ease: EASE_OUT } }}
            exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.08, ease: EASE_OUT } }}
            className="absolute top-0 left-0 flex w-64 cursor-default flex-col gap-2 p-2 text-ink"
          >
            {sent ? (
              <>
                <p className="px-1 text-[13px] whitespace-pre-wrap">{pin.text}</p>
                {pin.resolved === undefined ? (
                  <span className="px-1 text-[11px] text-ink-3">Sent to the agent</span>
                ) : (
                  <span data-slot="artifact-comment-resolved" className="flex items-start gap-1 px-1 text-[12px] text-green">
                    <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} className="mt-px shrink-0" aria-hidden />
                    <span>{pin.resolved}</span>
                  </span>
                )}
              </>
            ) : (
              <>
                <textarea
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- the bubble opens to be written in, like Figma's
                  autoFocus
                  aria-label={`Comment ${number} on ${pin.design.title}`}
                  value={pin.text}
                  placeholder="Add a comment"
                  onChange={(event) => comments.onText(pin.key, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      if (pin.text.trim()) comments.onSend();
                      else close();
                    } else if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      close();
                    } else if (event.key === "Escape") {
                      // Closes the bubble, not the canvas.
                      event.preventDefault();
                      close();
                    }
                  }}
                  // Grows with the comment up to eight lines, then scrolls; the surface follows the bubble's size.
                  className="field-sizing-content max-h-[8lh] min-h-[2lh] w-full resize-none rounded-[6px] bg-transparent px-1 text-[13px] leading-[1.4] focus:outline-none"
                />
                <div className="flex items-center justify-between text-[11px] text-ink-3">
                  <button type="button" onClick={() => comments.onRemove(pin.key)} className="rounded px-1 py-0.5 hover:bg-hover hover:text-ink">
                    Delete
                  </button>
                  <span>Enter to keep · {SEND_KEYS} to send</span>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
