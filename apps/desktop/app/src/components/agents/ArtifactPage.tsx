import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ARTIFACT_ESCAPE, artifactTab, onArtifactTab, type ArtifactPageMessage, type HtmlArtifact, type PagePin } from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import { THEME_EVENT } from "../../lib/theme-sheet";
import { ArtifactFrame, pageFiles, tellPage, type DesignPin, type PageState, type PinControls } from "./ArtifactCanvas";
import { saveArtifactDownload } from "./artifact-download";
import { CommentPin, commentCursor } from "./CommentPin";

export type PageHandle = {
  zoomBy: (factor: number) => void;
  zoomTo: (scale: number) => void;
  fit: () => void;
};

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
const BUBBLE = 264;

function usePinColors() {
  const read = () => {
    const style = getComputedStyle(document.documentElement);
    const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return {
      accent: value("--accent", "#007df3"),
      accentInk: value("--accent-ink", "#0068cd"),
      ink: value("--ink", "#191919"),
      surface: value("--surface", "#ffffff"),
      greenInk: value("--green-ink", "#007e33"),
      onAccent: value("--on-accent", "#ffffff"),
      onGreen: value("--on-green", "#ffffff"),
    };
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
 *
 * A page the agent split into tabs shows one tab's page at a time, the one the dock's title menu chose (`tabId`); a
 * comment is pinned on its tab, and opening one from the chat turns to that tab.
 */
export const ArtifactPage = forwardRef<
  PageHandle,
  {
    chatId: string;
    page: HtmlArtifact;
    tabId: string | null;
    onTab: (id: string) => void;
    commenting: boolean;
    comments: PinControls;
    numbers: Map<string, number>;
    reveal: { key: string; nonce: number } | null;
    onScale: (scale: number) => void;
    onToggleComment: () => void;
    onEscape: () => void;
  }
>(function ArtifactPage({ chatId, page, tabId, onTab, commenting, comments, numbers, reveal, onScale, onToggleComment, onEscape }, handle) {
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

  const [scale, setScale] = useState(1);
  const following = useRef(true);
  const [wide, setWide] = useState<number | null>(null);
  const tab = artifactTab(page, tabId);
  useEffect(() => setWide(null), [page.version, tab.id]);
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

  const [anchor, setAnchor] = useState<{ key: string; sx: number; sy: number; shown: boolean } | null>(null);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const onPage = useCallback(
    (message: ArtifactPageMessage) => {
      const controls = commentsRef.current;
      switch (message.t) {
        case "download":
          void saveArtifactDownload(chatId, page, frame.current?.src, message);
          return;
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
          const ref: ArtifactRef = { id: page.id, title: page.title, version: page.version, format: "html" };
          const key = controls.onPin(ref, message.x, message.y, undefined, {
            anchor: message.a || undefined,
            near: message.near || undefined,
            ...(page.tabs ? { tab: { id: tab.id, title: tab.title } } : {}),
          });
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
    [zoom, onToggleComment, chatId, page, tab.id, tab.title],
  );

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
  useEffect(() => {
    const pin = reveal && [...comments.sent, ...comments.pins].find((item) => item.key === reveal.key);
    if (pin?.tab) onTab(pin.tab.id);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- asked again by the nonce, not by the pins changing.
  }, [reveal?.key, reveal?.nonce]);
  const sentHere = comments.sent.filter((pin) => onArtifactTab(pin, page, tab) && (comments.showResolved || pin.resolved === undefined || pin.key === open));
  const waitingHere = waiting.filter((pin) => onArtifactTab(pin, page, tab));
  const pins = useMemo<PagePin[]>(
    () => [
      ...sentHere.map((pin) => {
        const number = numbers.get(pin.key) ?? "";
        const resolved = pin.resolved !== undefined;
        return {
          k: pin.key,
          x: pin.x,
          y: pin.y,
          ...(pin.anchor ? { a: pin.anchor } : {}),
          n: number,
          fill: resolved ? colors.greenInk : colors.ink,
          ink: resolved ? colors.onGreen : colors.surface,
          label: `Sent comment ${number}${resolved ? ", resolved" : ""}: ${pin.text}`,
          hide: pin.key === open,
        };
      }),
      ...waitingHere.map((pin) => {
        const number = comments.pins.indexOf(pin) + 1;
        return {
          k: pin.key,
          x: pin.x,
          y: pin.y,
          ...(pin.anchor ? { a: pin.anchor } : {}),
          n: number,
          fill: colors.accentInk,
          ink: colors.onAccent,
          label: `Comment ${number}${pin.text.trim() ? `: ${pin.text.trim()}` : ""}`,
          hide: pin.key === open,
        };
      }),
    ],
    [sentHere, comments.pins, waitingHere, numbers, colors, open],
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
    const sent = sentHere.find((pin) => pin.key === open);
    if (sent) return { ...sent, sent: true, number: numbers.get(sent.key) ?? 1 };
    const pin = waitingHere.find((item) => item.key === open);
    return pin ? { ...pin, sent: false, number: comments.pins.indexOf(pin) + 1 } : null;
  }, [sentHere, comments.pins, waitingHere, numbers, open]);
  const at = openPin && anchor?.key === openPin.key && anchor.shown ? anchor : null;

  const tabs = page.tabs && page.tabs.length > 1 ? page.tabs : null;
  return (
    <div ref={box} data-slot="artifact-page" className="relative min-h-0 flex-1 overflow-hidden bg-paper">
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={room.width ? { width: room.width / scale, height: room.height / scale, transform: `scale(${scale})` } : { width: "100%", height: "100%" }}
      >
        <ArtifactFrame
          html={tab.html}
          title={tabs ? `${page.title}: ${tab.title}` : page.title}
          format="html"
          page={state}
          onPage={onPage}
          frameRef={frame}
          files={pageFiles(chatId, page)}
        />
      </div>
      {openPin && at && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute" style={{ left: Math.max(0, Math.min(at.sx * scale, room.width - BUBBLE)), top: at.sy * scale }}>
            <CommentPin pin={{ ...openPin, x: 0, y: 0 }} number={openPin.number} open scale={1} comments={comments} sent={openPin.sent} />
          </div>
        </div>
      )}
    </div>
  );
});
