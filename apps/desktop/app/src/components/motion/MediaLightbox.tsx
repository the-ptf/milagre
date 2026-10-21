import { canCopyImage } from "../../lib/media";
import { animate, AnimatePresence, motion, type MotionValue, type Transition, useMotionValue, useTransform } from "motion/react";
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EASE_OUT, SPRING_LAYOUT, scaled, scaledSpring, useMotionScale } from "../../lib/ease";
import { containedRect, type Frame, panBy, type Rect, step, type View, zoomAt } from "../../lib/lightbox";

// `file` is what an image's right-click menu copies or saves: its absolute path, or a pasted image's data URL.
export type LightboxItem = { id: string; name: string; src: string; kind: "image" | "video"; file?: string };
type Media = HTMLImageElement | HTMLVideoElement;
type Zoom = View & { smooth?: boolean };
// A slide's figure and the motion values the morph drives, so a close mid-open starts from where it is.
// `corner` is the media's corner radius as seen on screen, so it can follow the thumbnail's rounding through the morph.
type Figure = {
  el: HTMLDivElement;
  x: MotionValue<number>;
  y: MotionValue<number>;
  scale: MotionValue<number>;
  opacity: MotionValue<number>;
  corner: MotionValue<number>;
};
type Pose = Partial<Record<"x" | "y" | "scale" | "opacity" | "corner", number>>;
// Each slide's elements by item id, so an exiting slide never stands in for the current one.
type Elements = { figures: Map<string, Figure>; media: Map<string, Media> };

const FIT: Zoom = { scale: 1, x: 0, y: 0 };
// The full-size media's corner radius, in screen pixels.
const CORNER = 8;
const SWIPE = 60;
const natural = (media: Media): [number, number] =>
  media instanceof HTMLImageElement ? [media.naturalWidth, media.naturalHeight] : [media.videoWidth, media.videoHeight];

// Where a thumbnail's media is drawn, if it is still on screen to morph into.
function thumbRect(thumb: HTMLElement | null | undefined): Rect | null {
  const media = thumb?.querySelector<Media>("img, video");
  if (!media) return null;
  const box = media.getBoundingClientRect();
  if (box.bottom < 0 || box.top > innerHeight) return null;
  return containedRect(box, ...natural(media));
}
// The rounding the thumbnail's media shows: a clipping box around it (a generated image's card), or its own
// corners when it fills its box. An object-contain thumbnail's corners sit in empty space, so it shows none.
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
  "flex size-9 items-center justify-center rounded-full bg-white/10 text-white/90 transition-colors hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-accent-ink";

export function MediaLightbox({
  items,
  start,
  thumbFor,
  onIndexChange,
  close,
}: {
  items: LightboxItem[];
  start: number;
  // The thumbnail button an item opens from, closes back into, and returns focus to.
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
  // Set when a press became a pan or a swipe, so the click that ends it neither zooms nor closes.
  const dragged = useRef(false);
  const item = items[index];
  // Listeners attach once, so they read the latest render through this.
  const latest = useRef({ index, zoom, closing, items, reduce, speed, thumbFor, onIndexChange, close });
  latest.current = { index, zoom, closing, items, reduce, speed, thumbFor, onIndexChange, close };
  const current = () => latest.current.items[latest.current.index];

  const frame = (): Frame | null => {
    const selected = current();
    const media = selected ? elements.media.get(selected.id) : undefined;
    if (!media || !stage.current) return null;
    return { width: media.offsetWidth, height: media.offsetHeight, frameWidth: stage.current.clientWidth, frameHeight: stage.current.clientHeight };
  };
  // A point relative to the stage centre, where the media is centred.
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
    setClosing(true);
    setZoom(FIT);
    const selected = current();
    if (!selected) return close();
    const figure = elements.figures.get(selected.id);
    if (!figure) return close();
    // Morph back into the thumbnail when it is on screen; otherwise just fade out.
    const thumb = thumbFor(selected.id),
      target = thumbRect(thumb);
    const run =
      !reduce && target
        ? pose(figure, { ...flip(figure, target), corner: thumbCorner(thumb) }, scaledSpring(SPRING_LAYOUT, speed))
        : pose(figure, { opacity: 0, scale: reduce ? 1 : 0.96 }, { duration: scaled(0.18, speed), ease: EASE_OUT });
    run.then(close);
  };

  const openDialog = (el: HTMLDialogElement | null) => {
    if (el && !el.open) el.showModal();
  };
  // The first media to load morphs out of its thumbnail.
  const ready = (figure: Figure) => {
    if (opened.current) return;
    opened.current = true;
    const { reduce, speed, thumbFor, items } = latest.current;
    // A cached image is ready before the dialog's ref and effect run, and a closed dialog has no size to morph from.
    openDialog(figure.el.closest("dialog"));
    // Decoding a large image at its full size takes a few frames; done first, the morph doesn't stall on it.
    const openingItem = items[start];
    const media = openingItem ? elements.media.get(openingItem.id) : undefined;
    void (media instanceof HTMLImageElement ? media.decode().catch(() => {}) : Promise.resolve()).then(() => {
      const thumb = openingItem ? thumbFor(openingItem.id) : undefined,
        source = thumbRect(thumb);
      if (reduce || !source) {
        figure.scale.jump(reduce ? 1 : 0.96);
        pose(figure, { opacity: 1, scale: 1 }, { duration: scaled(0.2, speed), ease: EASE_OUT });
        return;
      }
      // jump(), not set(): set() reads the leap to the thumbnail as velocity, and the spring would fling the image past it.
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
    // Captured so these keys never reach the chat behind (Escape there stops the agent).
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
    // Pinch or ⌘-scroll zooms, scrolling pans a zoomed image, a sideways swipe changes item.
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
      // Momentum keeps sending events after a swipe; wait for it to stop before the next one.
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
    // Capture only once a pan starts: captured clicks land on the stage, never on the image or the empty area.
    if (!start.moved) event.currentTarget.setPointerCapture(event.pointerId);
    setZoom(panBy(zoom, event.clientX - start.x, event.clientY - start.y, bounds));
    drag.current = { x: event.clientX, y: event.clientY, moved: true };
    dragged.current = true;
  };
  // A sideways drag on a fitted item changes item, like a swipe.
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
  // A click on an image zooms in at that point or back out; a click on the empty area around it closes.
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
    transition: { duration: scaled(closing ? 0.18 : 0.24, speed), ease: EASE_OUT },
  };
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={`Preview ${item.name}`}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      className="m-0 h-dvh max-h-none w-dvw max-w-none overflow-hidden bg-transparent p-0 text-white backdrop:bg-transparent"
    >
      <motion.div {...chrome} className="absolute inset-0 bg-black/70 backdrop-blur-overlay" onClick={requestClose} />
      <motion.header {...chrome} className="absolute inset-x-0 top-0 flex h-14 items-center justify-between px-4">
        <span aria-live="polite" className="text-xs tabular-nums text-white/70">
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
            transition={{ duration: scaled(0.22, speed), ease: EASE_OUT }}
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
        <span className="min-w-0 max-w-[60vw] truncate text-sm text-white/80" title={item.name}>
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
  // The figure's scale shrinks the radius with everything else, so divide it back out.
  const borderRadius = useTransform(() => corner.get() / scale.get());
  const loaded = () => {
    if (figure.current) onReady(figure.current);
  };
  const keep = (el: Media | null) => {
    if (el) elements.media.set(item.id, el);
  };
  // A cached image can finish loading before React attaches onLoad.
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
        // No rounding on video: clipping a playing video's corners repaints it on every frame of the morph.
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
          // Stopped here, since React bubbles it through the portal to whatever opened the viewer.
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
