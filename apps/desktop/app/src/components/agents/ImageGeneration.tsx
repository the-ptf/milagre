import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, RotateClockwiseIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { EASE_IN_OUT, EASE_OUT, SPRING_PRESS } from "../../lib/ease";

// Adapted from beUI's Image Generation (https://beui.dev/components/agents/image-generation, MIT).

export type ImageGenerationStatus = "queued" | "generating" | "refining" | "complete" | "error";

export interface ImageGenerationProps {
  /** The completed media: an img, canvas, video or custom preview. */
  children?: ReactNode;
  status?: ImageGenerationStatus;
  /** Accessible description. Defaults to one derived from the prompt. */
  label?: string;
  prompt?: string;
  /** CSS aspect ratio reserved before the generated media is available. */
  aspectRatio?: CSSProperties["aspectRatio"];
  size?: "compact" | "fluid";
  /** Lets the active dither cluster follow a fine pointer. */
  interactive?: boolean;
  statusText?: string;
  showStatus?: boolean;
  onRetry?: () => void;
  /** Controls over the completed media, e.g. copy and download; shown on hover or keyboard focus. */
  actions?: ReactNode;
  className?: string;
  mediaClassName?: string;
  statusClassName?: string;
}

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 14 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" aria-hidden />;
}

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" ");

const STATUS_TEXT: Record<ImageGenerationStatus, string> = {
  queued: "Waiting to generate",
  generating: "Generating image",
  refining: "Refining details",
  complete: "Image ready",
  error: "Generation failed",
};

const MEDIA_STATE: Record<ImageGenerationStatus, { filter: string; opacity: number; scale: number }> = {
  queued: { filter: "blur(4px) saturate(0.75)", opacity: 0, scale: 1.02 },
  generating: { filter: "blur(3px) saturate(0.85)", opacity: 0, scale: 1.015 },
  refining: { filter: "blur(1.5px) saturate(0.95)", opacity: 0.62, scale: 1.005 },
  complete: { filter: "blur(0px) saturate(1)", opacity: 1, scale: 1 },
  error: { filter: "blur(2px) saturate(0.5)", opacity: 0.28, scale: 1 },
};

const OVERLAY_OPACITY: Record<ImageGenerationStatus, number> = { queued: 1, generating: 1, refining: 0.48, complete: 0, error: 0 };

const DOT_GAP = 10;
const TWO_PI = Math.PI * 2;

function useHoverCapable() {
  const [capable, setCapable] = useState(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setCapable(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return capable;
}

function DitherMark({ status, reduce }: { status: ImageGenerationStatus; reduce: boolean }) {
  if (status === "complete") return <Icon icon={Tick02Icon} />;
  if (status === "error") return <Icon icon={Alert02Icon} />;
  return (
    <motion.span
      aria-hidden="true"
      animate={reduce ? undefined : { rotate: 360 }}
      transition={{ duration: 2.4, ease: EASE_IN_OUT, repeat: Number.POSITIVE_INFINITY }}
      className="grid size-3.5 grid-cols-2 place-items-center gap-0.5"
    >
      <span className="size-1 rounded-[1px] bg-current" />
      <span className="size-1 rounded-[1px] bg-current opacity-55" />
      <span className="size-1 rounded-[1px] bg-current opacity-55" />
      <span className="size-1 rounded-[1px] bg-current" />
    </motion.span>
  );
}

function DitherField({ interactive, reduce, status }: { interactive: boolean; reduce: boolean; status: ImageGenerationStatus }) {
  const canHover = useHoverCapable();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let frame = 0;
    let width = 0;
    let height = 0;
    let dotColor = "currentColor";
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, inside: false };
    const pointerEnabled = interactive && canHover && !reduce;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width || canvas.clientWidth || 208;
      height = rect.height || canvas.clientHeight || 208;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      dotColor = window.getComputedStyle(canvas).color;
      pointer.x = width / 2;
      pointer.y = height / 2;
      pointer.targetX = pointer.x;
      pointer.targetY = pointer.y;
    };

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      if (!pointer.inside) {
        pointer.targetX = width / 2 + (reduce ? 0 : Math.sin(time / 1700) * width * 0.12);
        pointer.targetY = height / 2 + (reduce ? 0 : Math.cos(time / 2100) * height * 0.1);
      }
      const follow = reduce ? 1 : pointer.inside ? 0.16 : 0.045;
      pointer.x += (pointer.targetX - pointer.x) * follow;
      pointer.y += (pointer.targetY - pointer.y) * follow;

      const radius = Math.min(width, height) * 0.38;
      const columns = Math.ceil(width / DOT_GAP) + 1;
      const rows = Math.ceil(height / DOT_GAP) + 1;
      const offsetX = (width - (columns - 1) * DOT_GAP) / 2;
      const offsetY = (height - (rows - 1) * DOT_GAP) / 2;
      context.fillStyle = dotColor;

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const anchorX = offsetX + column * DOT_GAP;
          const anchorY = offsetY + row * DOT_GAP;
          const deltaX = anchorX - pointer.x;
          const deltaY = anchorY - pointer.y;
          const distance = Math.hypot(deltaX, deltaY);
          const proximity = Math.max(0, 1 - distance / radius);
          const influence = proximity * proximity * (3 - 2 * proximity);
          const displacement = influence * influence * 9;
          const directionX = distance > 0 ? deltaX / distance : 0;
          const directionY = distance > 0 ? deltaY / distance : 0;
          context.globalAlpha = 0.17 + influence * 0.72;
          context.beginPath();
          context.arc(anchorX + directionX * displacement, anchorY + directionY * displacement, 0.65 + influence * 0.85, 0, TWO_PI);
          context.fill();
        }
      }

      context.globalAlpha = 1;
      if (!reduce) frame = window.requestAnimationFrame(draw);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerEnabled) return;
      const rect = canvas.getBoundingClientRect();
      pointer.inside = true;
      pointer.targetX = event.clientX - rect.left;
      pointer.targetY = event.clientY - rect.top;
    };
    const handlePointerLeave = () => {
      pointer.inside = false;
    };

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resize();
    resizeObserver?.observe(canvas);
    canvas.addEventListener("pointermove", handlePointerMove, { passive: true });
    canvas.addEventListener("pointerleave", handlePointerLeave);
    draw(0);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [canHover, interactive, reduce]);

  return (
    <motion.div
      aria-hidden="true"
      initial={false}
      animate={{ opacity: OVERLAY_OPACITY[status] }}
      transition={{ duration: reduce ? 0 : 0.4, ease: EASE_OUT }}
      className="absolute inset-0 overflow-hidden bg-field"
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full text-ink" />
    </motion.div>
  );
}

/** A generated image's surface: a dither field while it is made, the image once it is ready, at one size throughout. */
export function ImageGeneration({
  children,
  status = "generating",
  label,
  prompt,
  aspectRatio = "1 / 1",
  size = "compact",
  interactive = true,
  statusText,
  showStatus = true,
  onRetry,
  actions,
  className,
  mediaClassName,
  statusClassName,
}: ImageGenerationProps) {
  const reduce = useReducedMotion() ?? false;
  const active = status === "queued" || status === "generating" || status === "refining";
  const mediaState = MEDIA_STATE[status];
  const resolvedStatusText = statusText ?? STATUS_TEXT[status];
  const resolvedLabel = label ?? (prompt ? `${resolvedStatusText}: ${prompt}` : resolvedStatusText);

  return (
    <div data-slot="image-generation" data-state={status} aria-busy={active} className={cx("w-full", className)}>
      <div className={cx("w-full", size === "compact" && "mx-auto max-w-52")}>
        <div style={{ aspectRatio }} className="group/media relative isolate w-full overflow-hidden rounded-xl bg-field">
          <div role="img" aria-label={resolvedLabel} className="absolute inset-0" />
          <motion.div
            aria-hidden={children ? undefined : true}
            initial={false}
            animate={reduce ? { opacity: mediaState.opacity } : { filter: mediaState.filter, opacity: mediaState.opacity, scale: mediaState.scale }}
            transition={reduce ? { duration: 0 } : { duration: 0.4, ease: EASE_OUT }}
            className={cx("absolute inset-0 [&>*]:size-full [&>*]:object-cover [&_img]:size-full [&_img]:object-cover", mediaClassName)}
          >
            {children}
          </motion.div>

          <AnimatePresence initial={false}>
            {active ? (
              <motion.div
                key="dither-field"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0 : 0.25, ease: EASE_OUT }}
                className="absolute inset-0"
              >
                <DitherField interactive={interactive} reduce={reduce} status={status} />
              </motion.div>
            ) : null}
          </AnimatePresence>

          {status === "complete" && actions ? (
            <div className="absolute right-2 bottom-2 z-10 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/media:opacity-100 focus-within:opacity-100">
              {actions}
            </div>
          ) : null}
        </div>

        {showStatus || prompt ? (
          <div className="mt-2 text-left">
            {showStatus ? (
              <div
                aria-live="polite"
                className={cx("flex min-h-5 items-center gap-2 text-[12.5px] font-medium text-ink", status === "error" && "text-red-ink", statusClassName)}
              >
                <DitherMark status={status} reduce={reduce} />
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={resolvedStatusText}
                    initial={reduce ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? undefined : { opacity: 0, y: -4 }}
                    transition={{ duration: reduce ? 0 : 0.15, ease: EASE_OUT }}
                  >
                    {resolvedStatusText}
                  </motion.span>
                </AnimatePresence>
              </div>
            ) : null}
            {prompt ? (
              <div className="mt-0.5 truncate text-[12px] text-ink-3" title={prompt}>
                "{prompt}"
              </div>
            ) : null}
          </div>
        ) : null}

        {status === "error" && onRetry ? (
          <motion.button
            type="button"
            onClick={onRetry}
            whileTap={reduce ? undefined : { scale: 0.96 }}
            transition={SPRING_PRESS}
            className="mt-2 inline-flex min-h-8 items-center gap-2 rounded-full px-3 text-[12.5px] font-medium text-ink outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink-3"
          >
            <Icon icon={RotateClockwiseIcon} size={14} />
            Try again
          </motion.button>
        ) : null}
      </div>
    </div>
  );
}
