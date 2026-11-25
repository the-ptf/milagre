import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import type { DesignPin, PinControls } from "./ArtifactCanvas";
import { DURATION, EASE_OUT, useMotionScale } from "../../lib/ease";
import { THEME_EVENT } from "../../lib/theme-sheet";
import { useDismiss } from "../../lib/use-dismiss";
import { morphFace, useSize, HIDDEN_FACE } from "../motion/morph";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { CommentImageStrip, imageFilesOf, useCommentImages } from "./CommentImages";

const SEND_KEYS = /Mac/.test(navigator.userAgent) ? "⌘Enter" : "Ctrl+Enter";

const PIN = 20;
const PIN_RADIUS = `0 ${PIN / 2}px ${PIN / 2}px ${PIN / 2}px`;
const BUBBLE_RADIUS = "3px 10px 10px 10px";
const SURFACE =
  "transition-[width,height,border-radius,background-color,box-shadow] duration-base ease-enter motion-reduce:transition-none motion-reduce:duration-0";
const PIN_SHADOW = "var(--shadow-pin)";

const themeColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * The comment cursor: the pin's own shape, its point (top-left) on the spot a click pins, in the accent with a ring in
 * the theme's surface colour (a data URL can't read a CSS variable). The 2x image keeps it sharp on a Retina screen.
 */
export function commentCursor(fill: string, ring = themeColor("--surface") || "white") {
  const svg = (size: number) =>
    `url("data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 22 22"><path d="M2 2H11A9 9 0 0 1 20 11A9 9 0 0 1 11 20A9 9 0 0 1 2 11Z" fill="${fill}" stroke="${ring}" stroke-width="1.5" stroke-linejoin="miter"/></svg>`,
    )}")`;
  return `image-set(${svg(22)} 1x, ${svg(44)} 2x) 2 2, crosshair`;
}

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
    return commentCursor(themeColor("--accent-ink"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, theme]);
}

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
      role={commenting ? "group" : undefined}
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

export function CommentPin({
  pin,
  number,
  open,
  scale,
  comments,
  sent = false,
  offsetX = 0,
}: {
  pin: Pick<DesignPin, "key" | "x" | "y" | "text" | "resolved" | "images"> & { design: { title: string } };
  number: number;
  open: boolean;
  scale: number;
  comments: Pick<PinControls, "onOpen" | "onText" | "onRemove" | "onSend"> & Partial<Pick<PinControls, "onImages">>;
  offsetX?: number;
  sent?: boolean;
}) {
  const reduce = useReducedMotion();
  const motionScale = useMotionScale();
  const root = useRef<HTMLDivElement>(null);
  const [bubble, measureBubble] = useSize();
  const [lifted, setLifted] = useState(open);
  if (open && !lifted) setLifted(true);
  const onImages = comments.onImages;
  const attached = useCommentImages(pin.images, onImages && ((images) => onImages(pin.key, images)));
  const written = !!pin.text.trim() || !!pin.images?.length;
  const close = () => {
    if (!sent && !written) comments.onRemove(pin.key);
    comments.onOpen(null);
  };
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
  const [fill, ink] = pin.resolved !== undefined ? ["bg-green-ink", "text-on-green"] : sent ? ["bg-ink", "text-on-ink"] : ["bg-accent-ink", "text-on-accent"];
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
        marginLeft: open ? offsetX : undefined,
      }}
      onClick={(event) => event.stopPropagation()}
    >
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
        className={`absolute top-0 left-0 grid cursor-pointer place-items-center text-10 font-semibold ${ink} ${open ? HIDDEN_FACE : "visible"}`}
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
            animate={{ opacity: 1, transition: { duration: reduce ? 0 : DURATION.fast, delay: reduce ? 0 : 0.1, ease: EASE_OUT } }}
            exit={{ opacity: 0, transition: { duration: reduce ? 0 : DURATION.fast, ease: EASE_OUT } }}
            className="absolute top-0 left-0 flex w-64 cursor-default flex-col gap-2 p-2 text-ink"
            onDragOver={(event) => {
              if (sent || !attached.enabled || !event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              const files = imageFilesOf(event.dataTransfer);
              if (sent || !attached.enabled || !files.length) return;
              event.preventDefault();
              event.stopPropagation();
              void attached.add(files);
            }}
          >
            {sent ? (
              <>
                <p className="px-1 text-13 whitespace-pre-wrap">{pin.text}</p>
                {pin.resolved === undefined ? (
                  <span className="px-1 text-11 text-ink-3">Sent to the agent</span>
                ) : (
                  <span data-slot="artifact-comment-resolved" className="flex items-start gap-1 px-1 text-12 text-green-ink">
                    <Icon icon={CheckmarkCircle02Icon} size={12} className="mt-0.5 shrink-0" />
                    <span>{pin.resolved}</span>
                  </span>
                )}
              </>
            ) : (
              <>
                <textarea
                  autoFocus
                  onPaste={(event) => {
                    const files = imageFilesOf(event.clipboardData);
                    if (!files.length || !attached.enabled) return;
                    event.preventDefault();
                    void attached.add(files);
                  }}
                  aria-label={`Comment ${number} on ${pin.design.title}`}
                  value={pin.text}
                  placeholder="Add a comment"
                  onChange={(event) => comments.onText(pin.key, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      if (written) comments.onSend();
                      else close();
                    } else if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      close();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      close();
                    }
                  }}
                  className="field-sizing-content max-h-[8lh] min-h-[2lh] w-full resize-none rounded-chip bg-transparent px-1 text-13 outline-none"
                />
                <CommentImageStrip images={attached.images} onRemove={attached.remove} />
                {attached.error && (
                  <p role="alert" className="px-1 text-11 text-red-ink">
                    {attached.error}
                  </p>
                )}
                <div className="flex items-center justify-between text-11 text-ink-3">
                  <Button variant="danger-ghost" size={24} className="-ml-1" onClick={() => comments.onRemove(pin.key)}>
                    Delete
                  </Button>
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
