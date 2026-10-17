import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ARTIFACT_ESCAPE, type Artifact, type ArtifactPageMessage, type PagePin } from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import { THEME_EVENT } from "../../lib/theme-sheet";
import { ArtifactFrame, tellPage, type DesignPin, type PageState, type PinControls } from "./ArtifactCanvas";
import { CommentPin, commentCursor } from "./CommentPin";

/** What the dock's zoom bar asks of the page. */
export type PageHandle = {
  zoomBy: (factor: number) => void;
  zoomTo: (scale: number) => void;
  fit: () => void;
};

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
// The comment bubble's width (CommentPin's w-64) and a margin: a pin near the right edge opens it leftwards of the pin.
const BUBBLE = 264;

/** The pin colours of the current theme, as the page draws them: waiting, sent, resolved. */
function usePinColors() {
  const read = () => {
    const style = getComputedStyle(document.documentElement);
    const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return { accent: value("--accent", "#007df3"), ink: value("--ink", "#191919"), surface: value("--surface", "#ffffff"), green: value("--green", "#199a4d") };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const changed = () => setColors(read());
    window.addEventListener(THEME_EVENT, changed);
    return () => window.removeEventListener(THEME_EVENT, changed);
  }, []);
  return colors;
}

/**
 * The Chat's Artifact page in the dock: a web page that fills it and scrolls as one. Pinching (ctrl-wheel) zooms it
 * about the pointer, as the zoom bar does about the middle; a double-click away from text and controls fits it back,
 * to the page's width when it is wider than the dock, else to 100%. Zoomed, the page lays out at the width it then
 * fits, as a browser's zoom does.
 *
 * Comments are pinned on the page itself (its helper draws them, so they scroll with it): in comment mode a click
 * pins one, written in a bubble here at the pin's point, which follows the page as it scrolls.
 */
export const ArtifactPage = forwardRef<
  PageHandle,
  {
    page: Artifact;
    commenting: boolean;
    comments: PinControls;
    /** The number on each sent comment's pin, by its key. */
    numbers: Map<string, number>;
    /** A sent comment to bring into view, asked again by a new nonce. */
    reveal: { key: string; nonce: number } | null;
    onScale: (scale: number) => void;
    onToggleComment: () => void;
    onEscape: () => void;
  }
>(function ArtifactPage({ page, commenting, comments, numbers, reveal, onScale, onToggleComment, onEscape }, handle) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setRoom({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The zoom follows the fit until the user zooms; the fit is the page's own width when that is wider than the dock.
  const [scale, setScale] = useState(1);
  const following = useRef(true);
  const [wide, setWide] = useState<number | null>(null);
  useEffect(() => setWide(null), [page.version]);
  const fit = wide && room.width ? clamp(Math.min(1, room.width / wide)) : 1;
  useEffect(() => {
    if (following.current) setScale(fit);
  }, [fit]);
  useEffect(() => onScale(scale), [scale, onScale]);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const zoom = useCallback((next: number, at?: { cx: number; cy: number }) => {
    following.current = false;
    const value = clamp(next);
    // The point under the pointer stays put: the page scrolls to keep it once it has laid out at the new width.
    if (at) tellPage(frame.current, { t: "scale", s: value, ...at });
    setScale(value);
  }, []);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const middle = () => ({ cx: room.width / 2 / scaleRef.current, cy: room.height / 2 / scaleRef.current });
  useImperativeHandle(handle, () => ({
    zoomBy: (factor) => zoom(scaleRef.current * factor, middle()),
    zoomTo: (value) => zoom(value, middle()),
    fit: () => {
      following.current = true;
      setScale(fit);
    },
  }));

  // The open comment's bubble sits at its pin, in the page's pixels; the page says where as it scrolls.
  const [anchor, setAnchor] = useState<{ key: string; sx: number; sy: number; shown: boolean } | null>(null);
  const ref: ArtifactRef = { id: page.id, title: page.title, version: page.version, format: "html" };
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const onPage = useCallback(
    (message: ArtifactPageMessage) => {
      const controls = commentsRef.current;
      switch (message.t) {
        case "size":
          if (message.sw > message.cw + 1) setWide(message.sw);
          return;
        case "zoom":
          zoom(scaleRef.current * Math.exp(-message.dy * 0.01), { cx: message.cx, cy: message.cy });
          return;
        case "fit":
          following.current = true;
          setScale((current) => (Math.abs(current - fitRef.current) > 0.01 ? fitRef.current : current));
          return;
        case "key":
          onToggleComment();
          return;
        case "press": {
          const key = controls.onPin(ref, message.x, message.y, undefined, { anchor: message.a || undefined, near: message.near || undefined });
          if (key) setAnchor({ key, sx: message.sx, sy: message.sy, shown: true });
          return;
        }
        case "pin":
          controls.onOpen(message.k);
          setAnchor({ key: message.k, sx: message.sx, sy: message.sy, shown: true });
          return;
        case "anchor":
          setAnchor((current) =>
            current?.key === message.k || controls.open === message.k ? { key: message.k, sx: message.sx, sy: message.sy, shown: message.shown } : current,
          );
          return;
      }
    },
    // `ref` is rebuilt from `page` each render; the page's id and version are what it depends on.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [zoom, onToggleComment, page.id, page.version, page.title],
  );

  // Escape pressed in the page comes out as a message: comment mode first, then the dock.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data === ARTIFACT_ESCAPE && frame.current && event.source === frame.current.contentWindow) onEscape();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onEscape]);

  const colors = usePinColors();
  const open = comments.open;
  const waiting = comments.pins.filter((pin) => pin.design.id === page.id);
  const pins = useMemo<PagePin[]>(
    () => [
      ...comments.sent.map((pin) => {
        const number = numbers.get(pin.key) ?? "";
        const resolved = pin.resolved !== undefined;
        return {
          k: pin.key,
          x: pin.x,
          y: pin.y,
          ...(pin.anchor ? { a: pin.anchor } : {}),
          n: number,
          fill: resolved ? colors.green : colors.ink,
          ink: resolved ? "#ffffff" : colors.surface,
          label: `Sent comment ${number}${resolved ? ", resolved" : ""}: ${pin.text}`,
          hide: pin.key === open,
        };
      }),
      ...waiting.map((pin) => {
        const number = comments.pins.indexOf(pin) + 1;
        return {
          k: pin.key,
          x: pin.x,
          y: pin.y,
          ...(pin.anchor ? { a: pin.anchor } : {}),
          n: number,
          fill: colors.accent,
          ink: "#ffffff",
          label: `Comment ${number}${pin.text.trim() ? `: ${pin.text.trim()}` : ""}`,
          hide: pin.key === open,
        };
      }),
    ],
    [comments.sent, comments.pins, waiting, numbers, colors, open],
  );
  const cursor = useMemo(() => commentCursor(colors.accent), [colors.accent]);
  const state: PageState = {
    mode: { input: "mouse", comment: commenting, cursor },
    scale,
    pins,
    watch: open,
    ...(reveal ? { reveal } : {}),
  };

  const openPin: (DesignPin & { sent: boolean; number: number }) | null = useMemo(() => {
    const sent = comments.sent.find((pin) => pin.key === open);
    if (sent) return { ...sent, sent: true, number: numbers.get(sent.key) ?? 1 };
    const pin = waiting.find((item) => item.key === open);
    return pin ? { ...pin, sent: false, number: comments.pins.indexOf(pin) + 1 } : null;
  }, [comments.sent, comments.pins, waiting, numbers, open]);
  const at = openPin && anchor?.key === openPin.key && anchor.shown ? anchor : null;

  return (
    <div ref={box} data-slot="artifact-page" className="relative min-h-0 flex-1 overflow-hidden bg-white">
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={room.width ? { width: room.width / scale, height: room.height / scale, transform: `scale(${scale})` } : { width: "100%", height: "100%" }}
      >
        <ArtifactFrame html={page.html} title={page.title} format="html" page={state} onPage={onPage} frameRef={frame} />
      </div>
      {openPin && at && (
        // The bubble over the page; around it the page keeps the mouse.
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute" style={{ left: Math.max(0, Math.min(at.sx * scale, room.width - BUBBLE)), top: at.sy * scale }}>
            <CommentPin pin={{ ...openPin, x: 0, y: 0 }} number={openPin.number} open scale={1} comments={comments} sent={openPin.sent} />
          </div>
        </div>
      )}
    </div>
  );
});
