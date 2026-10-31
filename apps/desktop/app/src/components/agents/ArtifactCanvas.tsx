import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, CheckmarkCircle02Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import {
  ARTIFACT_CSP,
  ARTIFACT_ESCAPE,
  ARTIFACT_PAGE,
  artifactCsp,
  artifactDocument,
  createDesignFontReader,
  restoreDesignFonts,
  designGroups,
  readPageMessage,
  type Artifact,
  type ArtifactAsset,
  type ArtifactPageMessage,
  type DesignArtifact,
  type PagePin,
} from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import Tooltip from "../primitives/Tooltip";
import { onPanelResizeEnd, panelResizing } from "../../lib/panel-resizing";
import { useDesignsEnabled } from "../../lib/designs-enabled";
import { bridgeForKey, isRemoteKey, onComputerConnection } from "../../lib/computer-bridge";
import { DesignPageEditor as DesignEditor } from "./DesignPageEditor";
import { DESIGN_DELETED, type DesignDeleted } from "./DesignEditor";
import { designLayout, designNodeAt } from "@milagre/shared/design";
import { CommentLayer, CommentPin } from "./CommentPin";
import { LiveDesignLayer, LiveDesignWaiting, LiveDraftFrames } from "./LiveDesignFrame";
import { useLiveDesign } from "./design-live";

/** A comment the user pinned on a design and hasn't sent yet. */
export type DesignPin = {
  key: string;
  design: ArtifactRef;
  x: number;
  y: number;
  text: string;
  nodeId?: string;
  /** On an Artifact page: the element it was pinned on (ARTIFACT_PAGE_SCRIPT's anchor) and the text near it. */
  anchor?: string;
  near?: string;
  /** On an Artifact page split into tabs: the tab it was pinned on. */
  tab?: { id: string; title: string };
  resolved?: string;
  /** A sent comment's id, as the host and the agent know it. */
  commentId?: string;
};
/** The comments pinned on the canvas, the one whose bubble is open, and what changes them. */
export type PinControls = {
  pins: DesignPin[];
  /** Comments already sent: shown where they were left, to read, not to change. */
  sent: DesignPin[];
  open: string | null;
  /** Pins a new comment, its bubble open; returns its key. */
  onPin: (
    design: ArtifactRef,
    x: number,
    y: number,
    nodeId?: string,
    page?: { anchor?: string; near?: string; tab?: { id: string; title: string } },
  ) => string | void;
  onOpen: (key: string | null) => void;
  onText: (key: string, text: string) => void;
  onRemove: (key: string) => void;
  /** Sends every comment waiting and the chosen design, as the Send button does. */
  onSend: () => void;
};
/** The design the user chose and sent, the one chosen but not sent yet, and what toggles it. */
export type ChoiceControls = {
  sent: { id: string; version: number } | null;
  pending: ArtifactRef | null;
  onChoose: ((design: ArtifactRef) => void) | null;
};
export type CanvasView = { x: number; y: number; scale: number };

/** Screen spacing of the canvas dot grid: 24 canvas px, doubled as you zoom out so the dots never pack closer than 12 px into noise. */
function dotStep(scale: number) {
  let step = 24 * scale;
  while (step < 12) step *= 2;
  return step;
}

export type CanvasHandle = {
  zoomBy: (factor: number) => void;
  /** Zooms to this scale (1 is 100%) about the middle of the view. */
  zoomTo: (scale: number) => void;
  fitAll: () => void;
};

const GAP = 80;
// The title row above each frame, in screen pixels.
const HEADER = 32;
// A group's name above its block, in screen pixels, and the block's padding around its frames, in canvas pixels.
const GROUP_LABEL = 30;
const GROUP_PADDING = 48;
const MIN_SCALE = 0.05;
// Fit leaves this much room around the designs, in screen pixels; at the bottom, room for the zoom bar floating there
// (ArtifactDock: 16px from the edge, 32px tall), so neither a frame nor the agent's cursor on it goes under the bar.
const FIT_MARGIN = 24;
const FIT_BOTTOM = 56;
const MAX_SCALE = 2;
const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

// A version of a design never changes, so each is read from the host once and shared by every card, thumbnail and frame
// showing it. The newest (no version asked) can change, so it is read each time. Kept for the last few dozen.
const versionsRead = new Map<string, Promise<Artifact>>();
const versionsKept = new Map<string, Artifact>();
const fontReaders = new WeakMap<object, ReturnType<typeof createDesignFontReader<Artifact>>>();
const KEEP = 48;
export function readArtifact(chatId: string, id: string, version: number | null): Promise<Artifact> {
  const api = bridgeForKey(chatId).artifacts;
  const request = { chatId, id, ...(version === null ? {} : { version }) };
  const readDesign = () => {
    if (!isRemoteKey(chatId)) return api.get(request);
    let reader = fontReaders.get(api);
    if (!reader) {
      reader = createDesignFontReader((args) => api.get(args));
      fontReaders.set(api, reader);
      onComputerConnection(chatId, reader.reconnect, () => fontReaders.delete(api));
    }
    return reader(request).then(restoreDesignFonts);
  };
  if (version === null) return readDesign();
  const key = `${chatId}\n${id}\n${version}`;
  let read = versionsRead.get(key);
  if (!read) {
    read = readDesign();
    versionsRead.set(key, read);
    read.then(
      (artifact) => {
        versionsKept.set(key, artifact);
        for (const old of versionsKept.keys()) {
          if (versionsKept.size <= KEEP) break;
          versionsKept.delete(old);
          versionsRead.delete(old);
        }
      },
      // A read that failed is tried again next time.
      () => versionsRead.delete(key),
    );
  }
  return read;
}
const keptArtifact = (chatId: string | null, id: string, version: number | null) =>
  (chatId && version !== null && versionsKept.get(`${chatId}\n${id}\n${version}`)) || null;

export function useArtifact(chatId: string | null, id: string, version: number | null, revision?: number) {
  const { enabled } = useDesignsEnabled(chatId);
  const [state, setState] = useState<{
    artifact: Artifact | null;
    error: string | null;
  }>(() => ({ artifact: keptArtifact(chatId, id, version), error: null }));
  useEffect(() => {
    if (!chatId) return;
    let live = true;
    readArtifact(chatId, id, version)
      .then((artifact) => live && setState({ artifact, error: null }))
      .catch(
        (error: unknown) =>
          live &&
          setState({
            artifact: null,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      live = false;
    };
  }, [chatId, id, version, enabled, revision]);
  return chatId && (enabled || state.artifact?.format === "html") ? state : { artifact: null, error: null };
}

/** What an Artifact page's viewer keeps its helper told (ARTIFACT_PAGE_SCRIPT): sent again each time the page loads. */
export type PageState = {
  mode?: { input: "mouse"; comment: boolean; cursor?: string };
  pins?: PagePin[];
  /** The pin whose screen position the page reports as it scrolls. */
  watch?: string | null;
  /** The zoom the page is shown at, so its pins keep their size on screen. */
  scale?: number;
  /** A pin to scroll into view once the page has it; a new nonce asks again. */
  reveal?: { key: string; nonce: number };
};

/** An Artifact page's files, which its preview loads from the computer `chatId` is on (artifact:asset). */
export type PageFiles = { chatId: string; assets: ArtifactAsset[] };
/** The files an artifact shows, when it is an HTML page that has any. */
export const pageFiles = (chatId: string | null | undefined, artifact: Artifact | null | undefined): PageFiles | undefined =>
  chatId && artifact?.format === "html" && artifact.assets?.length ? { chatId, assets: artifact.assets } : undefined;
// The policy an isolated preview runs under (artifact-preview.cjs): its files load from the preview scheme.
const PREVIEW_CSP = artifactCsp("milagre-artifact:");

/** Sends a command to an Artifact page's helper. */
export function tellPage(frame: HTMLIFrameElement | null, command: Record<string, unknown> & { t: string }) {
  frame?.contentWindow?.postMessage({ ...command, milagre: ARTIFACT_PAGE }, "*");
}

/**
 * A design runs in a sandbox with no same origin and a policy that blocks its own requests: it can't reach Milagre,
 * the Chat or the network. A preview also takes no input, so the card scrolls with the chat. An HTML artifact carries
 * the page helper: `page` is what it is told each time it loads, and `onPage` hears it.
 */
export function ArtifactFrame({
  html,
  title,
  preview = false,
  format = "design",
  page,
  onPage,
  frameRef,
  files,
}: {
  html: string;
  title: string;
  preview?: boolean;
  format?: "design" | "html";
  /** An Artifact page's files, which its `assets/<name>` references load. */
  files?: PageFiles;
  page?: PageState;
  onPage?: (message: ArtifactPageMessage) => void;
  frameRef?: React.RefObject<HTMLIFrameElement | null>;
}) {
  const document = useMemo(() => artifactDocument(html, { page: format === "html" }), [html, format]);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const ready = useRef(false);
  const told = useRef<Record<string, string>>({});
  const pageRef = useRef(page);
  pageRef.current = page;
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  // Each part of the state goes to the page when it changes, and all of it again when the page says it is (again) ready.
  const tell = useCallback((all: boolean) => {
    const state = pageRef.current;
    if (!ready.current || !state) return;
    const parts: [string, Record<string, unknown> & { t: string }][] = [];
    if (state.mode) parts.push(["mode", { t: "mode", ...state.mode }]);
    if (state.scale !== undefined) parts.push(["scale", { t: "scale", s: state.scale }]);
    if (state.pins) parts.push(["pins", { t: "pins", pins: state.pins, watch: state.watch ?? null }]);
    if (state.reveal) parts.push(["reveal", { t: "reveal", k: state.reveal.key, n: state.reveal.nonce }]);
    for (const [name, command] of parts) {
      const key = JSON.stringify(command);
      if (!all && told.current[name] === key) continue;
      told.current[name] = key;
      tellPage(frame.current, command);
    }
  }, []);
  useEffect(() => tell(false));
  useEffect(() => {
    if (format !== "html") return;
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { milagre?: unknown } | null;
      if (!data || typeof data !== "object" || data.milagre !== ARTIFACT_PAGE) return;
      const message = readPageMessage(data);
      if (!message) return;
      if (message.t === "ready") {
        ready.current = true;
        tell(true);
      }
      onPageRef.current?.(message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [format, tell]);
  const setFrame = useCallback(
    (element: HTMLIFrameElement | null) => {
      frame.current = element;
      ready.current = false;
      if (frameRef) frameRef.current = element;
    },
    [frameRef],
  );
  const [registered, setRegistered] = useState<{ html: string; files: string; url: string } | null>(null);
  const [previewError, setPreviewError] = useState("");
  // The same files keep the same preview; a file the page swaps registers it again.
  const filesKey = files ? `${files.chatId}\n${files.assets.map((asset) => `${asset.name}:${asset.hash}`).join("\n")}` : "";
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => {
    if (format !== "html" || !window.milagre?.createArtifactPreview) return;
    let live = true;
    let url: string | undefined;
    setPreviewError("");
    void window.milagre
      .createArtifactPreview(html, filesRef.current)
      .then((value) => {
        url = value;
        if (live) setRegistered({ html, files: filesKey, url });
        else void window.milagre.releaseArtifactPreview(url);
      })
      .catch((cause) => {
        if (live) setPreviewError(String(cause));
      });
    return () => {
      live = false;
      if (url) void window.milagre.releaseArtifactPreview(url);
    };
  }, [html, format, filesKey]);
  const isolated = format === "html" && !!window.milagre?.createArtifactPreview;
  const url = registered?.html === html && registered.files === filesKey ? registered.url : undefined;
  if (isolated && !url)
    return (
      <div role={previewError ? "alert" : "status"} className="grid size-full place-items-center text-[12px] text-ink-3">
        {previewError || "Loading artifact..."}
      </div>
    );
  return (
    <iframe
      ref={setFrame}
      title={title}
      srcDoc={isolated ? undefined : document}
      src={isolated ? url : undefined}
      sandbox="allow-scripts"
      // The policy a second time, as the embedder's (Chromium holds the document to it), beside the <meta> inside.
      {...{ csp: isolated ? PREVIEW_CSP : ARTIFACT_CSP }}
      referrerPolicy="no-referrer"
      tabIndex={preview ? -1 : undefined}
      className={`block size-full border-0 bg-white ${preview ? "pointer-events-none" : ""}`}
    />
  );
}

/**
 * Every design of a Chat side by side, at the screen size each was made for. Drag the background or a frame's title
 * to pan, scroll to pan, and pinch or ⌘-scroll to zoom; scrolling over a design scrolls the design. In comment mode a
 * click on a design pins a comment there, written in a bubble beside the pin.
 */
export const ArtifactCanvas = forwardRef<
  CanvasHandle,
  {
    chatId: string;
    designs: ArtifactRef[];
    versions: Record<string, number | null>;
    onVersion: (id: string, version: number | null) => void;
    /** The design to bring into view, and a count that changes each time it is asked again. */
    focus: { id: string | null; nonce: number } | null;
    commenting: boolean;
    comments: PinControls;
    choice: ChoiceControls;
    onView: (view: CanvasView) => void;
  }
>(function ArtifactCanvas({ chatId, designs, versions, onVersion, focus, commenting, comments, choice, onView }, handle) {
  const viewport = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<CanvasView>({ x: 40, y: 40, scale: 0.4 });
  // One block per group once any design has one; until then the frames stay in one row, numbered across the blocks.
  const rows = useMemo(() => designGroups(designs), [designs]);
  const grouped = rows.some((row) => row.group);
  // Until the user pans or zooms, the canvas keeps the asked-for design in view as frames load and change size.
  const moved = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  // The dock shows only the zoom: panning doesn't re-render it.
  useEffect(() => onView({ x: viewRef.current.x, y: viewRef.current.y, scale: view.scale }), [view.scale, onView]);

  // Names and title rows keep their screen size, so they take more of the canvas at a smaller zoom: a fit that zooms
  // out measures the designs a little short, and fits again once they are laid out at the new zoom.
  const refits = useRef(0);
  const refit = useRef(0);
  // The user zooming or panning cancels a fit still settling: it would take the view back from them.
  const stopRefit = useCallback(() => {
    cancelAnimationFrame(refit.current);
    refits.current = 0;
  }, []);
  useEffect(() => stopRefit, [stopRefit]);
  const fit = useCallback(function fitDesigns(id?: string) {
    cancelAnimationFrame(refit.current);
    const port = viewport.current,
      content = board.current;
    if (!port || !content) return;
    // Fitting everything keeps the groups' blocks and names in view too.
    const frames = [
      ...content.querySelectorAll<HTMLElement>(
        id ? "[data-slot=artifact-frame]" : "[data-slot=artifact-frame], [data-slot=artifact-canvas-group], [data-slot=artifact-draft-frame]",
      ),
    ].filter((frame) => !id || frame.dataset.artifact === id);
    if (!frames.length) return;
    const left = Math.min(...frames.map((f) => f.offsetLeft)),
      top = Math.min(...frames.map((f) => f.offsetTop)),
      right = Math.max(...frames.map((f) => f.offsetLeft + f.offsetWidth)),
      bottom = Math.max(...frames.map((f) => f.offsetTop + f.offsetHeight));
    const width = port.clientWidth,
      height = port.clientHeight;
    const room = height - FIT_MARGIN - FIT_BOTTOM;
    const scale = clamp(Math.min((width - FIT_MARGIN * 2) / (right - left), room / (bottom - top), 1));
    setView({
      scale,
      x: (width - (right - left) * scale) / 2 - left * scale,
      y: FIT_MARGIN + (room - (bottom - top) * scale) / 2 - top * scale,
    });
    if (Math.abs(scale - viewRef.current.scale) > 0.005 && refits.current < 3) {
      refits.current++;
      refit.current = requestAnimationFrame(() => fitDesigns(id));
    } else refits.current = 0;
  }, []);

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      moved.current = true;
      stopRefit();
      setView((current) => {
        const scale = clamp(current.scale * factor);
        return {
          scale,
          x: px - (px - current.x) * (scale / current.scale),
          y: py - (py - current.y) * (scale / current.scale),
        };
      });
    },
    [stopRefit],
  );
  useImperativeHandle(
    handle,
    () => ({
      zoomBy: (factor) => {
        const port = viewport.current;
        if (port) zoomAt(factor, port.clientWidth / 2, port.clientHeight / 2);
      },
      zoomTo: (scale) => {
        const port = viewport.current;
        if (port) zoomAt(scale / viewRef.current.scale, port.clientWidth / 2, port.clientHeight / 2);
      },
      fitAll: () => {
        moved.current = true;
        fit();
      },
    }),
    [fit, zoomAt],
  );

  // A new focus (a card's Open) brings that design into view.
  useLayoutEffect(() => {
    moved.current = false;
    fit(focus?.id ?? undefined);
  }, [focus?.id, focus?.nonce, fit]);
  // A panel edge being dragged resizes the canvas on every frame: it fits once, when the drag ends.
  const fitAfterDrag = useRef(false);
  const settled = useCallback(() => {
    if (moved.current) return;
    if (panelResizing()) fitAfterDrag.current = true;
    else fit(focus?.id ?? undefined);
  }, [fit, focus?.id]);
  useEffect(() => {
    const port = viewport.current;
    if (!port) return;
    const observer = new ResizeObserver(settled);
    observer.observe(port);
    const offDragEnd = onPanelResizeEnd(() => {
      if (!fitAfterDrag.current) return;
      fitAfterDrag.current = false;
      settled();
    });
    return () => {
      observer.disconnect();
      offDragEnd();
    };
  }, [settled]);

  // A design an agent starts writing joins the view, until the user pans or zooms.
  const showDraft = useCallback(() => {
    if (!moved.current && !panelResizing()) fit();
  }, [fit]);

  // Wheel events need a listener that can cancel them: React's is passive.
  useEffect(() => {
    const port = viewport.current;
    if (!port) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = port.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      else {
        moved.current = true;
        stopRefit();
        setView((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
      }
    };
    port.addEventListener("wheel", onWheel, { passive: false });
    return () => port.removeEventListener("wheel", onWheel);
  }, [zoomAt, stopRefit]);

  // The design taking the mouse, Figma-like: designs let wheel and drag pan the canvas until one is clicked, and a
  // click elsewhere or Escape hands the mouse back to the canvas.
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("[data-slot=design-editor]")) return;
      // Leaves the design, not the canvas.
      event.preventDefault();
      setActive(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);
  // Escape pressed in a design (its frame has the focus, so the window never sees the key) arrives as a message: the
  // focus comes back to the canvas and the key goes on as if pressed here, leaving the design, then comment mode,
  // then the canvas. Only this canvas's own frames are listened to.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data !== ARTIFACT_ESCAPE || !event.source) return;
      const frames = board.current?.querySelectorAll("iframe") ?? [];
      if (![...frames].some((frame) => frame.contentWindow === event.source)) return;
      // Blurring the frame leaves the focus inside it; focusing the canvas takes it out. The key starts from the canvas,
      // as a real one would: dispatched on the window itself, its listeners would run in the order they were added,
      // the canvas's capturing one no longer first.
      const port = viewport.current;
      if (!port) return;
      port.focus({ preventScroll: true });
      port.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  // `design` is the design a press started on: released without dragging, it hands that design the mouse. (The pointer
  // capture that keeps a drag going sends the click to the canvas, so a click handler on the design never fires.)
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    design: string | null;
  } | null>(null);
  // Whether the last press moved the canvas: a drag that starts on a design pans, and doesn't then select it.
  const dragged = useRef(false);
  const onPointerDown = (event: React.PointerEvent) => {
    const target = event.target as HTMLElement;
    if (!target.closest(`[data-slot=artifact-frame][data-artifact="${active}"] [data-design-body]`)) setActive(null);
    if (event.button !== 0 || target.closest("button, textarea, [data-design-body]")) return;
    dragged.current = false;
    const design = target.closest("[data-slot=artifact-shield]") ? (target.closest<HTMLElement>("[data-slot=artifact-frame]")?.dataset.artifact ?? null) : null;
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX - viewRef.current.x,
      y: event.clientY - viewRef.current.y,
      startX: event.clientX,
      startY: event.clientY,
      design,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    if (!dragged.current && Math.hypot(event.clientX - start.startX, event.clientY - start.startY) < 4) return;
    dragged.current = true;
    moved.current = true;
    stopRefit();
    setView((current) => ({
      ...current,
      x: event.clientX - start.x,
      y: event.clientY - start.y,
    }));
  };
  const endDrag = (event: React.PointerEvent) => {
    const start = drag.current;
    drag.current = null;
    if (event.type === "pointerup" && start?.design && !dragged.current) setActive(start.design);
  };

  return (
    <div
      ref={viewport}
      data-slot="artifact-canvas"
      tabIndex={-1}
      className={`relative min-h-0 flex-1 touch-none overflow-hidden bg-canvas outline-none ${drag.current ? "cursor-grabbing" : "cursor-grab"}`}
      style={{
        backgroundImage: "radial-gradient(var(--color-line) 1px, transparent 1px)",
        backgroundSize: `${dotStep(view.scale)}px ${dotStep(view.scale)}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        ref={board}
        className="absolute top-0 left-0 flex origin-top-left flex-col items-start"
        style={{
          gap: GAP,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        {rows.map((row, index) => (
          <section
            key={row.group ?? ""}
            data-slot={grouped ? "artifact-canvas-group" : undefined}
            data-group={row.group ?? undefined}
            aria-label={grouped ? (row.group ?? "Ungrouped") : undefined}
            className={grouped ? "flex flex-col items-start" : "contents"}
          >
            {grouped && (
              <div className="relative shrink-0" style={{ height: GROUP_LABEL / view.scale }}>
                <div
                  className="absolute bottom-0 left-0 flex origin-bottom-left items-baseline gap-2 pb-2 text-[13px] whitespace-nowrap"
                  style={{ transform: `scale(${1 / view.scale})` }}
                >
                  <span className={`font-medium ${row.group ? "text-ink" : "text-ink-3"}`}>{row.group ?? "Ungrouped"}</span>
                  <span className="text-ink-3 tabular-nums">{row.designs.length}</span>
                </div>
              </div>
            )}
            <div
              className={`flex items-start ${grouped ? "rounded-[40px] bg-hover/60" : ""}`}
              style={{ gap: GAP, padding: grouped ? GROUP_PADDING : undefined }}
            >
              {row.designs.map((design, offset) => (
                <DesignFrame
                  key={design.id}
                  chatId={chatId}
                  design={design}
                  number={rows.slice(0, index).reduce((total, row) => total + row.designs.length, 0) + offset + 1}
                  version={versions[design.id] ?? null}
                  onVersion={onVersion}
                  commenting={commenting}
                  comments={comments}
                  choice={choice}
                  onSized={settled}
                  active={active === design.id}
                  scale={view.scale}
                />
              ))}
              <LiveDraftFrames chatId={chatId} designs={designs} group={row.group} scale={view.scale} gap={GAP} header={HEADER} onSized={showDraft} />
            </div>
          </section>
        ))}
        <LiveDraftFrames
          chatId={chatId}
          designs={designs}
          orphans={rows.map((row) => row.group)}
          scale={view.scale}
          gap={GAP}
          header={HEADER}
          onSized={showDraft}
        />
      </div>
      {!designs.length && <LiveDesignWaiting chatId={chatId} />}
    </div>
  );
});

// Memoized: panning re-renders the canvas, not its frames.
const DesignFrame = memo(function DesignFrame({
  chatId,
  design,
  number,
  version,
  onVersion,
  commenting,
  comments,
  choice,
  onSized,
  scale,
  active,
}: {
  chatId: string;
  design: ArtifactRef;
  number: number;
  version: number | null;
  onVersion: (id: string, version: number | null) => void;
  commenting: boolean;
  comments: PinControls;
  choice: ChoiceControls;
  onSized: () => void;
  /** Whether this design takes the mouse; until it does, wheel and drag over it move the canvas. */
  active: boolean;
  /** The canvas zoom: a frame's title row stays this size on screen however far the canvas zooms. */
  scale: number;
}) {
  // Following the newest unless the user stepped back; a revision the agent shows replaces what is in the frame, after
  // the change plays back over it (`hold`, design-live.ts).
  const { live, hold } = useLiveDesign(chatId, design, version === null);
  const { artifact, error } = useArtifact(chatId, design.id, design.format === "html" ? null : (hold ?? version ?? design.version));
  const [editing, setEditing] = useState<DesignArtifact | null>(null);
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editError, setEditError] = useState("");
  const edit = async () => {
    setOpeningEditor(true);
    setEditError("");
    try {
      // Versions remain immutable; an editor always begins at the newest saved document.
      const latest = await bridgeForKey(chatId).artifacts.get({
        chatId,
        id: design.id,
      });
      if (latest.format !== "design" || !latest.document) throw new Error("The latest version has no editable layers.");
      setEditing({ ...latest, document: latest.document });
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpeningEditor(false);
    }
  };
  // Delete asks once more in place: the first press arms it, the second deletes every version.
  const [deleting, setDeleting] = useState<"confirm" | "busy" | null>(null);
  const remove = async () => {
    setDeleting("busy");
    setEditError("");
    try {
      await bridgeForKey(chatId).artifacts.delete({ chatId, id: design.id });
      window.dispatchEvent(new CustomEvent<DesignDeleted>(DESIGN_DELETED, { detail: { chatId, id: design.id } }));
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause));
      setDeleting(null);
    }
  };
  const width = artifact?.width ?? 1280,
    height = artifact?.height ?? 800;
  useLayoutEffect(onSized, [width, height, onSized]);
  const shown: ArtifactRef = {
    id: design.id,
    version: artifact?.version ?? version ?? design.version,
    title: artifact?.title ?? design.title,
    format: artifact?.format ?? design.format,
  };
  const last = Math.max(artifact?.latest ?? 1, design.version);
  // Chosen and sent, or chosen here and waiting for Send; a pending choice of another design outranks a sent one.
  const pendingHere = choice.pending?.id === design.id && choice.pending.version === shown.version;
  const sentHere = !choice.pending && choice.sent?.id === design.id && choice.sent.version === shown.version;
  const isChosen = pendingHere || sentHere;
  const framePins = comments.pins.filter((pin) => pin.design.id === design.id && pin.design.version === shown.version);
  const followsLayer = comments.sent.some((pin) => pin.design.id === design.id && pin.nodeId && shown.version >= pin.design.version);
  const pinDocument = artifact?.format === "design" ? artifact.document : undefined;
  const layerBounds = useMemo(() => (followsLayer && pinDocument ? designLayout(pinDocument) : null), [pinDocument, followsLayer]);
  const sentPins = comments.sent.flatMap((pin) => {
    if (pin.design.id !== design.id) return [];
    if (pin.nodeId && layerBounds && shown.version >= pin.design.version) {
      const bounds = layerBounds.get(pin.nodeId);
      // A layer's comments move with its current bounds; removed or hidden layers have no visible pin.
      return bounds
        ? [
            {
              ...pin,
              x: (bounds.x + bounds.width / 2) / width,
              y: (bounds.y + bounds.height / 2) / height,
            },
          ]
        : [];
    }
    return pin.design.version === shown.version ? [pin] : [];
  });
  const go = (next: number) => onVersion(design.id, next >= last ? null : next);
  // Too narrow on screen for the title and its controls on one row, the controls go under the title. Zoomed out
  // further, the controls wouldn't fit under it either: the row keeps the number and title, and the controls float
  // over the frame's top edge while the pointer or focus is on it, clear of the group's name above the row.
  const compact = width * scale < 260;
  const narrow = !compact && width * scale < 300;
  const button = "grid size-6 place-items-center rounded-[6px] text-ink-2 hover:bg-hover disabled:opacity-40";
  const controls = (
    <>
      {design.format !== "html" && (
        <>
          <Tooltip label="Previous version">
            <button
              type="button"
              aria-label={`Previous version of ${shown.title}`}
              disabled={shown.version <= 1}
              onClick={() => go(shown.version - 1)}
              className={button}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={14} aria-hidden />
            </button>
          </Tooltip>
          <span className="text-ink-3 tabular-nums" data-slot="artifact-frame-version">
            v{shown.version} of {last}
          </span>
          <Tooltip label="Next version">
            <button
              type="button"
              aria-label={`Next version of ${shown.title}`}
              disabled={shown.version >= last}
              onClick={() => go(shown.version + 1)}
              className={button}
            >
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} aria-hidden />
            </button>
          </Tooltip>
        </>
      )}
      {artifact?.format === "design" && (
        <button
          type="button"
          data-slot="artifact-edit"
          aria-label={`Edit ${shown.title}`}
          disabled={openingEditor}
          onClick={() => void edit()}
          className="rounded-[6px] border border-line bg-surface px-2 py-0.5 text-ink hover:bg-hover disabled:opacity-40"
        >
          {openingEditor ? "Opening..." : "Edit"}
        </button>
      )}
      {design.format === "design" &&
        (deleting ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              data-slot="artifact-delete-confirm"
              aria-label={`Delete ${shown.title} and every version`}
              disabled={deleting === "busy"}
              onClick={() => void remove()}
              className="rounded-[6px] bg-red px-2 py-0.5 text-white hover:opacity-90 disabled:opacity-50"
            >
              {deleting === "busy" ? "Deleting..." : "Delete"}
            </button>
            <button
              type="button"
              disabled={deleting === "busy"}
              onClick={() => setDeleting(null)}
              className="rounded-[6px] px-2 py-0.5 text-ink-2 hover:bg-hover disabled:opacity-40"
            >
              Cancel
            </button>
          </span>
        ) : (
          <Tooltip label="Delete design">
            <button type="button" data-slot="artifact-delete" aria-label={`Delete ${shown.title}`} onClick={() => setDeleting("confirm")} className={button}>
              <HugeiconsIcon icon={Delete02Icon} size={14} aria-hidden />
            </button>
          </Tooltip>
        ))}
      {sentHere ? (
        <span data-slot="artifact-chosen" className="flex items-center gap-1.5 rounded-[6px] bg-accent/10 px-2 py-0.5 text-accent">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} aria-hidden />
          Chosen
        </span>
      ) : (
        choice.onChoose && (
          <button
            type="button"
            aria-label={pendingHere ? `Unchoose ${shown.title}` : `Choose ${shown.title}, version ${shown.version}`}
            aria-pressed={pendingHere}
            data-slot={pendingHere ? "artifact-choice-pending" : undefined}
            onClick={() => choice.onChoose?.(shown)}
            className={`flex items-center gap-1.5 rounded-[6px] border px-2 py-0.5 ${pendingHere ? "border-accent bg-accent/10 text-accent" : "border-line bg-surface text-ink hover:bg-hover"}`}
          >
            {pendingHere && <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} aria-hidden />}
            {pendingHere ? "Chosen" : "Choose"}
          </button>
        )
      )}
    </>
  );
  return (
    <div data-slot="artifact-frame" data-artifact={design.id} data-version={shown.version} className="group/frame flex shrink-0 flex-col" style={{ width }}>
      <div
        className={`relative shrink-0 ${compact ? "group-focus-within/frame:z-20 group-hover/frame:z-20" : ""}`}
        style={{ height: (narrow ? HEADER * 2 : HEADER) / scale }}
      >
        <div
          className={`absolute bottom-0 left-0 flex origin-bottom-left items-center gap-1 pb-1.5 text-[12px] text-ink ${narrow ? "flex-wrap content-end" : ""}`}
          style={{
            width: width * scale,
            height: narrow ? HEADER * 2 : HEADER,
            transform: `scale(${1 / scale})`,
          }}
        >
          <span className="text-ink-3">{number}</span>
          <span className={`min-w-0 flex-1 truncate ${narrow ? "basis-[calc(100%-1.5rem)]" : ""}`} title={compact ? shown.title : undefined}>
            {shown.title}
          </span>
          {compact ? (
            <>
              {isChosen && <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} aria-label="Chosen" className="shrink-0 text-accent" />}
              <div
                data-slot="artifact-frame-controls"
                className={`absolute top-full left-1.5 mt-1.5 flex items-center gap-1 whitespace-nowrap rounded-[8px] border border-line bg-surface p-1 shadow-raised ${deleting ? "" : "pointer-events-none opacity-0 group-focus-within/frame:pointer-events-auto group-focus-within/frame:opacity-100 group-hover/frame:pointer-events-auto group-hover/frame:opacity-100"}`}
              >
                {controls}
              </div>
            </>
          ) : (
            controls
          )}
        </div>
      </div>
      <div className="relative" style={{ width, height }}>
        <div
          data-design-body
          data-active={active || undefined}
          className={`size-full overflow-hidden rounded-[12px] border-2 bg-white shadow-raised ${isChosen || active ? "border-accent" : "border-line"} ${active ? "" : "[&_iframe]:pointer-events-none"}`}
        >
          {artifact ? (
            <ArtifactFrame html={artifact.html} title={shown.title} format={artifact.format} files={pageFiles(chatId, artifact)} />
          ) : (
            <div className="grid size-full place-items-center text-ink-3" style={{ fontSize: 24 }}>
              {error ?? "Loading…"}
            </div>
          )}
        </div>
        <LiveDesignLayer chatId={chatId} live={live} shown={artifact?.version ?? null} width={width} height={height} scale={scale} />
        {!active && !commenting && (
          // Over a design that doesn't have the mouse: wheel and drag reach the canvas, and a click (see endDrag) hands it the mouse.
          <div data-slot="artifact-shield" aria-label={`Interact with ${shown.title}`} className="absolute inset-0 cursor-grab" />
        )}
        {(commenting || framePins.length > 0 || sentPins.length > 0) && (
          // Over the design, so a click pins a comment instead of reaching the design.
          <CommentLayer
            commenting={commenting}
            title={shown.title}
            onPin={(x, y) =>
              artifact && comments.onPin(shown, x, y, artifact.format === "design" ? designNodeAt(artifact.document, x * width, y * height)?.id : undefined)
            }
          >
            {sentPins.map((pin) => (
              <CommentPin
                key={pin.key}
                pin={pin}
                number={Number(pin.key.split(":").at(-1)) + 1}
                open={comments.open === pin.key}
                scale={scale}
                comments={comments}
                sent
              />
            ))}
            {framePins.map((pin) => (
              <CommentPin key={pin.key} pin={pin} number={comments.pins.indexOf(pin) + 1} open={comments.open === pin.key} scale={scale} comments={comments} />
            ))}
          </CommentLayer>
        )}
      </div>
      {editError && (
        <p role="alert" className="max-w-full px-2 text-[12px] text-red-ink">
          {editError}
        </p>
      )}
      {editing && <DesignEditor chatId={chatId} artifact={editing} latestVersion={last} onClose={() => setEditing(null)} />}
    </div>
  );
});
