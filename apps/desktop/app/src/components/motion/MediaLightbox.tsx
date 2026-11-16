import { canCopyImage } from "../../lib/media";
import { animate, AnimatePresence, motion, type MotionValue, type Transition, useMotionValue, useTransform } from "motion/react";
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DURATION, EASE_OUT, SPRING_LAYOUT, scaled, scaledSpring, useMotionScale } from "../../lib/ease";
import { containedRect, type Frame, panBy, type Rect, step, type View, zoomAt } from "../../lib/lightbox";

export type LightboxItem = { id: string; name: string; src: string; kind: "image" | "video"; file?: string };
type Media = HTMLImageElement | HTMLVideoElement;
type Zoom = View & { smooth?: boolean };
type Figure = {
  el: HTMLDivElement;
  x: MotionValue<number>;
  y: MotionValue<number>;
  scale: MotionValue<number>;
  opacity: MotionValue<number>;
  corner: MotionValue<number>;
};
type Pose = Partial<Record<"x" | "y" | "scale" | "opacity" | "corner", number>>;
type Elements = { figures: Map<string, Figure>; media: Map<string, Media> };

const FIT: Zoom = { scale: 1, x: 0, y: 0 };
const CORNER = 8;
const SWIPE = 60;
const natural = (media: Media): [number, number] =>
  media instanceof HTMLImageElement ? [media.naturalWidth, media.naturalHeight] : [media.videoWidth, media.videoHeight];

function thumbRect(thumb: HTMLElement | null | undefined): Rect | null {
  const media = thumb?.querySelector<Media>("img, video");
  if (!media) return null;
  const box = media.getBoundingClientRect();
  if (box.bottom < 0 || box.top > innerHeight) return null;
  return containedRect(box, ...natural(media));
}
function thumbCorner(thumb: HTMLElement | null | undefined): number {
  const media = thumb?.querySelector<Media>("img, video");
  if (!media) return 0;
  const radius = (el: Element) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  if (getComputedStyle(media).objectFit !== "contain" && radius(media)) return radius(media);
  for (let el = media.parentElement, depth = 0; el && depth < 5; el = el.parentElement, depth++) {
    if (getComputedStyle(el).overflow !== "visible" && radius(el)) return radius(el);
  }
  return 0;
}
// The transform that puts the figure's untransformed box exactly over `to`, with a centre origin.
function flip(figure: Figure, to: Rect) {
  const box = figure.el.getBoundingClientRect(),
    scale = figure.scale.get();
  const left = box.left + box.width / 2 - figure.x.get(),
    top = box.top + box.height / 2 - figure.y.get(),
    width = box.width / scale;
  return { x: to.left + to.width / 2 - left, y: to.top + to.height / 2 - top, scale: to.width / width };
}
function pose(figure: Figure, to: Pose, transition: Transition) {
  return Promise.all(
    (Object.keys(to) as (keyof Pose)[]).flatMap((key) => {
      const value = to[key];
      return value === undefined ? [] : [animate(figure[key], value, transition)];
    }),
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg aria-hidden viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const control =
  "flex size-9 items-center justify-center rounded-full bg-on-media-tint text-on-media transition-[background-color,scale] duration-fast hover:bg-on-media/20 enabled:active:scale-press disabled:opacity-40 disabled:hover:bg-on-media-tint";

export function MediaLightbox({
  items,
  start,
  thumbFor,
  onIndexChange,
  close,
}: {
  items: LightboxItem[];
  start: number;
  thumbFor: (id: string) => HTMLElement | null | undefined;
  onIndexChange?: (index: number) => void;
  close: () => void;
}) {
  const speed = useMotionScale();
  const reduce = speed === 0;
  const [index, setIndex] = useState(start);
  const [direction, setDirection] = useState(0);
  const [zoom, setZoom] = useState<Zoom>(FIT);
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const elements = useRef<Elements>({ figures: new Map(), media: new Map() }).current;
  const opened = useRef(false);
  const swipe = useRef({ total: 0, last: 0, lockedUntil: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const item = items[index];
  const latest = useRef({ index, zoom, closing, items, reduce, speed, thumbFor, onIndexChange, close });
  latest.current = { index, zoom, closing, items, reduce, speed, thumbFor, onIndexChange, close };
  const current = () => latest.current.items[latest.current.index];

  const frame = (): Frame | null => {
    const selected = current();
    const media = selected ? elements.media.get(selected.id) : undefined;
    if (!media || !stage.current) return null;
    return { width: media.offsetWidth, height: media.offsetHeight, frameWidth: stage.current.clientWidth, frameHeight: stage.current.clientHeight };
  };
  const fromCentre = (clientX: number, clientY: number) => {
    const area = stage.current;
    if (!area) return null;
    const box = area.getBoundingClientRect();
    return { x: clientX - box.left - box.width / 2, y: clientY - box.top - box.height / 2 };
  };

  const go = (by: number) => {
    const { index, items, closing, onIndexChange } = latest.current;
    const next = step(index, by, items.length);
    if (!items[index] || !items[next] || next === index || closing) return;
    setDirection(by);
    setIndex(next);
    setZoom(FIT);
    onIndexChange?.(next);
  };

  const requestClose = () => {
    const { closing, reduce, speed, thumbFor, close } = latest.current;
    if (closing) return;
    latest.current.closing = true;
    setClosing(true);
    setZoom(FIT);
    const selected = current();
    if (!selected) return close();
    const figure = elements.figures.get(selected.id);
    if (!figure) return close();
    const thumb = thumbFor(selected.id),
      target = thumbRect(thumb);
    const run =
      !reduce && target
        ? pose(figure, { ...flip(figure, target), corner: thumbCorner(thumb) }, scaledSpring(SPRING_LAYOUT, speed))
        : pose(figure, { opacity: 0, scale: reduce ? 1 : 0.96 }, { duration: scaled(DURATION.base, speed), ease: EASE_OUT });
    run.then(close);
  };

  const openDialog = (el: HTMLDialogElement | null) => {
    if (el && !el.open) el.showModal();
  };
  const ready = (figure: Figure) => {
    if (opened.current) return;
    opened.current = true;
    const { reduce, speed, thumbFor, items } = latest.current;
    openDialog(figure.el.closest("dialog"));
    const openingItem = items[start];
    const media = openingItem ? elements.media.get(openingItem.id) : undefined;
    void (media instanceof HTMLImageElement ? media.decode().catch(() => {}) : Promise.resolve()).then(() => {
      if (latest.current.closing) return;
      const thumb = openingItem ? thumbFor(openingItem.id) : undefined,
        source = thumbRect(thumb);
      if (reduce || !source) {
        figure.scale.jump(reduce ? 1 : 0.96);
        pose(figure, { opacity: 1, scale: 1 }, { duration: scaled(DURATION.base, speed), ease: EASE_OUT });
        return;
      }
      const from = flip(figure, source);
      figure.x.jump(from.x);
      figure.y.jump(from.y);
      figure.scale.jump(from.scale);
      figure.corner.jump(thumbCorner(thumb));
      figure.opacity.jump(1);
      pose(figure, { x: 0, y: 0, scale: 1, corner: CORNER }, scaledSpring(SPRING_LAYOUT, speed));
    });
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    openDialog(dialog.current);
    const keys = (event: KeyboardEvent) => {
      const nudge = ({ ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] } as Record<string, [number, number]>)[event.key];
      if (event.key !== "Escape" && !nudge) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return requestClose();
      if (!nudge) return;
      const zoom = latest.current.zoom,
        bounds = frame();
      if (zoom.scale > 1 && bounds) setZoom({ ...panBy(zoom, nudge[0], nudge[1], bounds), smooth: true });
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") go(event.key === "ArrowLeft" ? -1 : 1);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const zoom = latest.current.zoom,
        bounds = frame();
      if ((event.ctrlKey || event.metaKey) && bounds && current()?.kind === "image") {
        const point = fromCentre(event.clientX, event.clientY);
        if (point) setZoom(zoomAt(zoom, zoom.scale * Math.exp(-event.deltaY * 0.01), point, bounds));
        return;
      }
      if (zoom.scale > 1 && bounds) {
        setZoom(panBy(zoom, -event.deltaX, -event.deltaY, bounds));
        return;
      }
      const now = performance.now(),
        s = swipe.current;
      if (now < s.lockedUntil) {
        s.lockedUntil = now + 200;
        return;
      }
      if (now - s.last > 200) s.total = 0;
      s.last = now;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      s.total += event.deltaX;
      if (Math.abs(s.total) < SWIPE) return;
      go(Math.sign(s.total));
      s.total = 0;
      s.lockedUntil = now + 200;
    };
    const area = stage.current;
    window.addEventListener("keydown", keys, true);
    area?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", keys, true);
      area?.removeEventListener("wheel", wheel);
      dialog.current?.close();
      const selected = current();
      const thumb = selected ? latest.current.thumbFor(selected.id) : undefined;
      (thumb ?? previous)?.focus();
    };
  }, []);

  const pointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    dragged.current = false;
    drag.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const pointerMove = (event: ReactPointerEvent) => {
    const start = drag.current,
      bounds = frame();
    if (!start || !bounds || zoom.scale <= 1) return;
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
    if (!start.moved) event.currentTarget.setPointerCapture(event.pointerId);
    setZoom(panBy(zoom, event.clientX - start.x, event.clientY - start.y, bounds));
    drag.current = { x: event.clientX, y: event.clientY, moved: true };
    dragged.current = true;
  };
  const pointerUp = (event: ReactPointerEvent) => {
    const start = drag.current;
    drag.current = null;
    if (!start || start.moved || zoom.scale > 1) return;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy)) {
      dragged.current = true;
      go(dx < 0 ? 1 : -1);
    }
  };
  const click = (event: ReactMouseEvent) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    const target = event.target as Element;
    if (target instanceof HTMLVideoElement) return;
    if (!(target instanceof HTMLImageElement)) return requestClose();
    const bounds = frame();
    const point = fromCentre(event.clientX, event.clientY);
    if (!bounds || !point) return;
    setZoom(zoom.scale > 1 ? { ...FIT, smooth: true } : { ...zoomAt(zoom, 2.5, point, bounds), smooth: true });
  };

  useEffect(() => {
    if (!item) close();
  }, [item, close]);

  if (!item) return null;

  const chrome = {
    initial: { opacity: 0 },
    animate: { opacity: closing ? 0 : 1 },
    transition: { duration: scaled(closing ? DURATION.base : DURATION.slow, speed), ease: EASE_OUT },
  };
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={`Preview ${item.name}`}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      className="m-0 h-dvh max-h-none w-dvw max-w-none overflow-hidden bg-transparent p-0 text-on-media backdrop:bg-transparent"
    >
      <motion.div {...chrome} className="absolute inset-0 bg-media/70 backdrop-blur-overlay" onClick={requestClose} />
      <motion.header {...chrome} className="absolute inset-x-0 top-0 flex h-14 items-center justify-between px-4">
        <span aria-live="polite" className="text-12 tabular-nums text-on-media-2">
          {items.length > 1 ? `${index + 1} / ${items.length}` : ""}
        </span>
        <button autoFocus type="button" aria-label="Close preview" onClick={requestClose} className={control}>
          <Icon d="M6 6l12 12M18 6L6 18" />
        </button>
      </motion.header>
      <div
        ref={stage}
        className="absolute inset-x-0 top-14 bottom-18 overflow-hidden"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onClick={click}
      >
        <AnimatePresence initial={false} custom={direction}>
          <motion.div
            key={item.id}
            custom={direction}
            variants={{
              enter: (by: number) => ({ opacity: 0, x: reduce ? 0 : by * 48 }),
              center: { opacity: 1, x: 0 },
              exit: (by: number) => ({ opacity: 0, x: reduce ? 0 : by * -48 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: scaled(DURATION.base, speed), ease: EASE_OUT }}
            className="absolute inset-0 flex items-center justify-center p-4"
          >
            <Slide item={item} intro={!opened.current} zoom={zoom} elements={elements} onReady={ready} />
          </motion.div>
        </AnimatePresence>
      </div>
      <motion.footer {...chrome} className="absolute inset-x-0 bottom-0 flex h-18 items-center justify-center gap-4 px-4">
        {items.length > 1 && (
          <button type="button" aria-label="Previous" disabled={index === 0} onClick={() => go(-1)} className={control}>
            <Icon d="M15 6l-6 6 6 6" />
          </button>
        )}
        <span className="min-w-0 max-w-[60vw] truncate text-13 text-on-media-2" title={item.name}>
          {item.name}
        </span>
        {items.length > 1 && (
          <button type="button" aria-label="Next" disabled={index === items.length - 1} onClick={() => go(1)} className={control}>
            <Icon d="M9 6l6 6-6 6" />
          </button>
        )}
      </motion.footer>
    </dialog>,
    document.body,
  );
}

function Slide({
  item,
  intro,
  zoom,
  elements,
  onReady,
}: {
  item: LightboxItem;
  intro: boolean;
  zoom: Zoom;
  elements: Elements;
  onReady: (figure: Figure) => void;
}) {
  const figure = useRef<Figure>(null);
  const speed = useMotionScale();
  const x = useMotionValue(0),
    y = useMotionValue(0),
    scale = useMotionValue(1),
    opacity = useMotionValue(intro ? 0 : 1),
    corner = useMotionValue(CORNER);
  const borderRadius = useTransform(() => corner.get() / scale.get());
  const loaded = () => {
    if (figure.current) onReady(figure.current);
  };
  const keep = (el: Media | null) => {
    if (el) elements.media.set(item.id, el);
  };
  useLayoutEffect(() => {
    const media = elements.media.get(item.id);
    if (media instanceof HTMLImageElement && media.complete && media.naturalWidth) loaded();
  }, []);
  const fit = "block max-h-[calc(100dvh-10rem)] max-w-[calc(100vw-2rem)] object-contain";
  return (
    <motion.div
      ref={(el) => {
        if (!el) return;
        figure.current = { el, x, y, scale, opacity, corner };
        elements.figures.set(item.id, figure.current);
      }}
      style={{ x, y, scale, opacity }}
      className="flex"
    >
      {item.kind === "video" ? (
        <video ref={keep} src={item.src} controls autoPlay onLoadedMetadata={loaded} onError={loaded} className={fit} />
      ) : (
        <motion.img
          ref={keep}
          style={{ borderRadius }}
          src={item.src}
          alt={item.name}
          draggable={false}
          onLoad={loaded}
          onError={loaded}
          onContextMenu={
            canCopyImage(item.file)
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void window.milagre.showImageMenu(item.file!, item.name);
                }
              : undefined
          }
          data-zoom={zoom.scale.toFixed(2)}
          animate={{ scale: zoom.scale, x: zoom.x, y: zoom.y }}
          transition={zoom.smooth ? scaledSpring(SPRING_LAYOUT, speed) : { duration: 0 }}
          className={`${fit} select-none ${zoom.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
        />
      )}
    </motion.div>
  );
}
