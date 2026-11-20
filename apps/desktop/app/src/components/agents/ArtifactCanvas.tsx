import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, CheckmarkCircle02Icon, Delete02Icon, Download04Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import {
  ARTIFACT_CSP,
  DESIGN_CODE_CSP,
  ARTIFACT_ESCAPE,
  ARTIFACT_PAGE,
  artifactCsp,
  artifactDocument,
  createDesignFontReader,
  restoreDesignFonts,
  designGroups,
  designKitLabel,
  isInteractiveDesign,
  readPageMessage,
  type Artifact,
  type ArtifactAsset,
  type ArtifactPageMessage,
  type PagePin,
} from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import Tooltip from "../primitives/Tooltip";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { onPanelResizeEnd, panelResizing } from "../../lib/panel-resizing";
import { useDesignsEnabled } from "../../lib/designs-enabled";
import { bridgeForKey, isRemoteKey, onComputerConnection } from "../../lib/computer-bridge";
import { DESIGN_DELETED, type DesignDeleted } from "./design-events";
import { DesignExportDialog } from "./DesignExportDialog";
import { MenuRow, Popover } from "../primitives/Popover";
import { designLayout, designNodeAt } from "@milagre/shared/design";
import { DESIGN_MODE_LABELS, designModesOf } from "@milagre/shared/design-modes";
import { CanvasDesignBody, downloadHtml } from "./CanvasDesignBody";
import { useDesignMode } from "./design-mode";
import { DesignFrameChips } from "./DesignFrameChips";
import { CommentLayer, CommentPin } from "./CommentPin";
import { LiveDesignLayer, LiveDesignWaiting, LiveDraftFrames } from "./LiveDesignFrame";
import { useLiveDesign } from "./design-live";
import { designPreviews, designPreviewKey, designLiveZoom } from "./design-preview-cache";
import { createDesignVisibility, designDensity, subscribeDesignDensity } from "./design-visibility";

export type DesignPin = {
  key: string;
  design: ArtifactRef;
  x: number;
  y: number;
  text: string;
  nodeId?: string;
  anchor?: string;
  near?: string;
  tab?: { id: string; title: string };
  resolved?: string;
  commentId?: string;
};
export type PinControls = {
  showResolved?: boolean;
  pins: DesignPin[];
  sent: DesignPin[];
  open: string | null;
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
  onSend: () => void;
};
export type ChoiceControls = {
  sent: { id: string; version: number } | null;
  pending: ArtifactRef | null;
  onChoose: ((design: ArtifactRef) => void) | null;
};
export type CanvasView = { x: number; y: number; scale: number };

function dotStep(scale: number) {
  let step = 24 * scale;
  while (step < 12) step *= 2;
  return step;
}

export type CanvasHandle = {
  zoomBy: (factor: number) => void;
  zoomTo: (scale: number) => void;
  fitAll: () => void;
};

const GAP = 80;
const HEADER = 32;
const GROUP_LABEL = 30;
const MIN_SCALE = 0.05;
const FIT_MARGIN = 24;
const FIT_BOTTOM = 56;
const MAX_SCALE = 8;
const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

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
          designPreviews.delete(old);
          versionsRead.delete(old);
        }
      },
      () => versionsRead.delete(key),
    );
  }
  return read;
}
export const designVersionKept = (key: string) => versionsKept.has(key);
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

export type PageState = {
  mode?: { input: "mouse"; comment: boolean; cursor?: string };
  pins?: PagePin[];
  watch?: string | null;
  scale?: number;
  reveal?: { key: string; nonce: number };
};

export type PageFiles = { chatId: string; assets: ArtifactAsset[] };
export const pageFiles = (chatId: string | null | undefined, artifact: Artifact | null | undefined): PageFiles | undefined =>
  chatId && artifact?.format === "html" && artifact.assets?.length ? { chatId, assets: artifact.assets } : undefined;
const PREVIEW_CSP = artifactCsp("milagre-artifact:");

export function tellPage(frame: HTMLIFrameElement | null, command: Record<string, unknown> & { t: string }) {
  frame?.contentWindow?.postMessage({ ...command, milagre: ARTIFACT_PAGE }, "*");
}

export function ArtifactFrame({
  html,
  title,
  preview = false,
  format = "design",
  code = false,
  page,
  onPage,
  frameRef,
  files,
  onLoad,
}: {
  html: string;
  title: string;
  preview?: boolean;
  format?: "design" | "html";
  code?: boolean;
  files?: PageFiles;
  page?: PageState;
  onPage?: (message: ArtifactPageMessage) => void;
  frameRef?: React.RefObject<HTMLIFrameElement | null>;
  onLoad?: () => void;
}) {
  const document = useMemo(() => artifactDocument(html, { page: format === "html", code }), [html, format, code]);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const ready = useRef(false);
  const told = useRef<Record<string, string>>({});
  const pageRef = useRef(page);
  pageRef.current = page;
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
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
  const filesKey = files ? `${files.chatId}\n${files.assets.map((asset) => `${asset.name}:${asset.hash}`).join("\n")}` : "";
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => {
    if ((format !== "html" && !code) || !window.milagre?.createArtifactPreview) return;
    let live = true;
    let url: string | undefined;
    setPreviewError("");
    void window.milagre
      .createArtifactPreview(html, code ? { code: true } : filesRef.current)
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
  }, [html, format, code, filesKey]);
  const isolated = (format === "html" || code) && !!window.milagre?.createArtifactPreview;
  const url = registered?.html === html && registered.files === filesKey ? registered.url : undefined;
  if (isolated && !url)
    return (
      <div role={previewError ? "alert" : "status"} className={`grid size-full place-items-center text-12 ${previewError ? "text-red-ink" : "text-ink-3"}`}>
        {previewError || (code ? "Loading design…" : "Loading artifact…")}
      </div>
    );
  return (
    <iframe
      ref={setFrame}
      onLoad={onLoad}
      title={title}
      srcDoc={isolated ? undefined : document}
      src={isolated ? url : undefined}
      sandbox="allow-scripts"
      // The policy a second time, as the embedder's (Chromium holds the document to it), beside the <meta> inside.
      {...{ csp: code ? DESIGN_CODE_CSP : isolated ? PREVIEW_CSP : ARTIFACT_CSP }}
      referrerPolicy="no-referrer"
      tabIndex={preview ? -1 : undefined}
      className={`block size-full border-0 bg-paper ${preview ? "pointer-events-none" : ""}`}
    />
  );
}

export const ArtifactCanvas = forwardRef<
  CanvasHandle,
  {
    chatId: string;
    allowLive?: boolean;
    designs: ArtifactRef[];
    versions: Record<string, number | null>;
    onVersion: (id: string, version: number | null) => void;
    focus: { id: string | null; nonce: number } | null;
    commenting: boolean;
    comments: PinControls;
    choice: ChoiceControls;
    onView: (view: CanvasView) => void;
  }
>(function ArtifactCanvas({ chatId, allowLive = true, designs, versions, onVersion, focus, commenting, comments, choice, onView }, handle) {
  const viewport = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const visibility = useMemo(() => createDesignVisibility(), []);
  const pixelRatio = useSyncExternalStore(subscribeDesignDensity, designDensity);
  useLayoutEffect(() => {
    if (viewport.current) return visibility.connect(viewport.current);
  }, [visibility]);
  const [view, setView] = useState<CanvasView>({ x: 40, y: 40, scale: 0.4 });
  const rows = useMemo(() => designGroups(designs), [designs]);
  const grouped = rows.some((row) => row.group);
  const moved = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => onView({ x: viewRef.current.x, y: viewRef.current.y, scale: view.scale }), [view.scale, onView]);

  const refits = useRef(0);
  const refit = useRef(0);
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

  useLayoutEffect(() => {
    moved.current = false;
    fit(focus?.id ?? undefined);
  }, [focus?.id, focus?.nonce, fit]);
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

  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setActive(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data !== ARTIFACT_ESCAPE || !event.source) return;
      const frames = board.current?.querySelectorAll("iframe") ?? [];
      if (![...frames].some((frame) => frame.contentWindow === event.source)) return;
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
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    design: string | null;
  } | null>(null);
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
        {rows.map((row) => (
          <section
            key={row.group ?? ""}
            data-slot={grouped ? "artifact-canvas-group" : undefined}
            data-group={row.group ?? undefined}
            aria-label={grouped ? (row.group ?? "Ungrouped") : undefined}
            className={grouped ? "flex flex-col items-start" : "contents"}
          >
            {grouped && (
              <div className="relative shrink-0 self-stretch" style={{ height: GROUP_LABEL / view.scale }}>
                <div
                  className="absolute bottom-0 left-0 flex origin-bottom-left items-center gap-2 pb-2 text-13 whitespace-nowrap"
                  style={{ transform: `scale(${1 / view.scale})`, width: `${view.scale * 100}%` }}
                >
                  <span className={`font-medium ${row.group ? "text-ink-2" : "text-ink-3"}`}>{row.group ?? "Ungrouped"}</span>
                  <span className="text-ink-3 tabular-nums">{row.designs.length}</span>
                  <span aria-hidden className="h-px min-w-6 flex-1 bg-line" />
                </div>
              </div>
            )}
            <div className="flex items-start" style={{ gap: GAP }}>
              {row.designs.map((design, offset) => (
                <DesignFrame
                  key={`${chatId}\n${design.id}`}
                  chatId={chatId}
                  design={design}
                  label={optionLabel(offset)}
                  dimmed={dimmedInRow(row.designs, design.id, choice)}
                  version={versions[design.id] ?? null}
                  onVersion={onVersion}
                  commenting={commenting}
                  comments={comments}
                  choice={choice}
                  onSized={settled}
                  active={active === design.id}
                  scale={view.scale}
                  allowLive={allowLive}
                  visibility={visibility}
                  pixelRatio={pixelRatio}
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

function optionLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : optionLabel(Math.floor(index / 26) - 1) + optionLabel(index % 26);
}

function dimmedInRow(row: ArtifactRef[], id: string, choice: ChoiceControls): boolean {
  const chosen = choice.pending ?? choice.sent;
  return !!chosen && chosen.id !== id && row.some((design) => design.id === chosen.id);
}

const DesignFrame = memo(function DesignFrame({
  chatId,
  design,
  label,
  dimmed,
  version,
  onVersion,
  commenting,
  comments,
  choice,
  onSized,
  scale,
  active,
  visibility,
  allowLive,
  pixelRatio,
}: {
  chatId: string;
  design: ArtifactRef;
  label: string;
  /** Another option in the same group is chosen: this one steps back until the pointer is on it. */
  dimmed: boolean;
  version: number | null;
  onVersion: (id: string, version: number | null) => void;
  commenting: boolean;
  comments: PinControls;
  choice: ChoiceControls;
  onSized: () => void;
  active: boolean;
  scale: number;
  visibility: ReturnType<typeof createDesignVisibility>;
  allowLive: boolean;
  pixelRatio: number;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [liveZoom, setLiveZoom] = useState(false);
  useLayoutEffect(() => {
    if (frame.current) return visibility.watch(frame.current, setInView);
  }, [visibility]);
  useEffect(() => {
    const timer = setTimeout(() => setLiveZoom((previous) => designLiveZoom(previous, scale)), 150);
    return () => clearTimeout(timer);
  }, [scale]);
  const [painted, setPainted] = useState<Artifact | null>(null);
  const { live, hold } = useLiveDesign(chatId, design, version === null);
  const { artifact, error } = useArtifact(chatId, design.id, design.format === "html" ? null : (hold ?? version ?? design.version));
  const markPainted = useCallback((ready: boolean) => setPainted(ready ? artifact : null), [artifact]);
  const [editError, setEditError] = useState("");
  const moreAnchor = useRef<HTMLSpanElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
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
  const [chosenMode, setMode] = useDesignMode(chatId, design.id);
  const modes = artifact?.format === "design" && artifact.document ? designModesOf(artifact.document) : ["light" as const];
  const mode = modes.includes(chosenMode) ? chosenMode : "light";
  const pendingHere = choice.pending?.id === design.id && choice.pending.version === shown.version;
  const sentHere = !choice.pending && choice.sent?.id === design.id && choice.sent.version === shown.version;
  const isChosen = pendingHere || sentHere;
  const framePins = comments.pins.filter((pin) => pin.design.id === design.id && pin.design.version === shown.version);
  const followsLayer = comments.sent.some((pin) => pin.design.id === design.id && pin.nodeId && shown.version >= pin.design.version);
  const pinDocument = artifact?.format === "design" ? artifact.document : undefined;
  const layerBounds = useMemo(() => (followsLayer && pinDocument ? designLayout(pinDocument) : null), [pinDocument, followsLayer]);
  const sentPins = comments.sent.flatMap((pin) => {
    if (pin.design.id !== design.id) return [];
    if (!comments.showResolved && pin.resolved !== undefined && pin.key !== comments.open) return [];
    if (pin.nodeId && layerBounds && shown.version >= pin.design.version) {
      const bounds = layerBounds.get(pin.nodeId);
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
  // The actions float over the frame's top edge while the pointer or focus is on it. Zoomed out too far for the chips,
  const compact = width * scale < 200;
  const tight = width * scale < 320;
  const controls = (
    <>
      {design.format !== "html" && (
        <>
          <Tooltip label="Previous version" asChild>
            <IconButton
              label={`Previous version of ${shown.title}`}
              icon={ArrowLeft01Icon}
              size={24}
              disabled={shown.version <= 1}
              onClick={() => go(shown.version - 1)}
            />
          </Tooltip>
          <span className="text-ink-3 tabular-nums" data-slot="artifact-frame-version">
            v{shown.version} of {last}
            {artifact?.kit && (
              <span className="ml-2" title={designKitLabel(artifact)}>
                {designKitLabel(artifact)}
              </span>
            )}
          </span>
          <Tooltip label="Next version" asChild>
            <IconButton
              label={`Next version of ${shown.title}`}
              icon={ArrowRight01Icon}
              size={24}
              disabled={shown.version >= last}
              onClick={() => go(shown.version + 1)}
            />
          </Tooltip>
        </>
      )}
      {artifact?.format === "design" && (
        <span ref={moreAnchor} className="inline-flex">
          <Tooltip label="More" asChild>
            <IconButton
              data-slot="artifact-more"
              label={`More actions for ${shown.title}`}
              icon={MoreHorizontalIcon}
              size={24}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            />
          </Tooltip>
          {moreOpen && (
            <Popover anchor={moreAnchor} label={`${shown.title} actions`} onClose={() => setMoreOpen(false)}>
              {modes.length > 1 &&
                modes.map((item) => (
                  <MenuRow
                    key={item}
                    data-slot="artifact-mode"
                    role="menuitemradio"
                    checked={item === mode}
                    title={DESIGN_MODE_LABELS[item]}
                    onClick={() => {
                      setMoreOpen(false);
                      setMode(item);
                    }}
                  />
                ))}
              <MenuRow
                data-slot="artifact-export"
                icon={Download04Icon}
                title={isInteractiveDesign(artifact) ? "Download HTML" : "Export…"}
                onClick={() => {
                  setMoreOpen(false);
                  if (isInteractiveDesign(artifact)) downloadHtml(artifact.html, `${artifact.id}-v${artifact.version}.html`);
                  else setExporting(true);
                }}
              />
            </Popover>
          )}
        </span>
      )}
      {design.format === "design" &&
        (deleting ? (
          <span className="flex items-center gap-1">
            <Button
              variant="danger"
              size={24}
              data-slot="artifact-delete-confirm"
              aria-label={`Delete ${shown.title} and every version`}
              disabled={deleting === "busy"}
              onClick={() => void remove()}
            >
              {deleting === "busy" ? "Deleting…" : "Delete"}
            </Button>
            <Button variant="ghost" size={24} disabled={deleting === "busy"} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Tooltip label="Delete design" asChild>
            <IconButton
              data-slot="artifact-delete"
              variant="danger-ghost"
              label={`Delete ${shown.title}`}
              icon={Delete02Icon}
              size={24}
              onClick={() => setDeleting("confirm")}
            />
          </Tooltip>
        ))}
      {!sentHere && choice.onChoose && (
        <button
          type="button"
          aria-label={pendingHere ? `Unchoose ${shown.title}` : `Choose ${shown.title}, version ${shown.version}`}
          aria-pressed={pendingHere}
          data-slot={pendingHere ? "artifact-choice-pending" : undefined}
          onClick={() => choice.onChoose?.(shown)}
          className={`flex h-6 items-center gap-1.5 rounded-control px-2 font-medium transition-colors ${pendingHere ? "bg-hover-2 text-ink" : "bg-surface text-ink shadow-btn hover:bg-hover"}`}
        >
          {pendingHere && <Icon icon={CheckmarkCircle02Icon} size={14} />}
          {pendingHere ? "Chosen" : "Choose"}
        </button>
      )}
    </>
  );
  // has more than one, and chosen. The actions stay out of the way until the pointer or focus is on the frame.
  return (
    <div
      ref={frame}
      data-slot="artifact-frame"
      data-artifact={design.id}
      data-version={shown.version}
      className="group/frame flex shrink-0 flex-col"
      style={{ width }}
    >
      <div className="relative z-10 shrink-0 group-focus-within/frame:z-20 group-hover/frame:z-20" style={{ height: HEADER / scale }}>
        <div
          className="absolute bottom-0 left-0 flex origin-bottom-left items-center gap-1.5 pb-1.5 text-12"
          style={{ width: width * scale, height: HEADER, transform: `scale(${1 / scale})` }}
        >
          <span className="shrink-0 font-semibold text-ink-3" data-slot="artifact-frame-label">
            {label}
          </span>
          <span className={`min-w-0 flex-1 truncate font-medium ${dimmed ? "text-ink-2" : "text-ink"}`} title={shown.title}>
            {shown.title}
          </span>
          {compact ? (
            isChosen && <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.8} aria-label="Chosen" className="shrink-0 text-ink" />
          ) : (
            <DesignFrameChips
              interactive={isInteractiveDesign(artifact)}
              active={active}
              tight={tight}
              mode={mode}
              version={shown.version}
              last={last}
              chosen={isChosen ? (sentHere ? "sent" : "pending") : null}
            />
          )}
          <div
            data-slot="artifact-frame-controls"
            className={`absolute top-full left-1.5 mt-1.5 flex items-center gap-1 whitespace-nowrap rounded-control bg-surface p-1 text-ink shadow-raised ${deleting || moreOpen ? "" : "pointer-events-none opacity-0 transition-opacity group-focus-within/frame:pointer-events-auto group-focus-within/frame:opacity-100 group-hover/frame:pointer-events-auto group-hover/frame:opacity-100"}`}
          >
            {controls}
          </div>
        </div>
      </div>
      <div className="relative rounded-card bg-canvas" style={{ width, height }}>
        <div
          data-design-body
          data-painted={(!!artifact && painted === artifact) || undefined}
          data-active={active || undefined}
          className={`size-full overflow-hidden rounded-card border-2 bg-paper shadow-raised transition-opacity ${active ? "border-accent" : isChosen ? "border-ink" : "border-transparent"} ${active ? "" : "[&_iframe]:pointer-events-none"} ${dimmed && !active ? "opacity-45 group-hover/frame:opacity-100" : ""}`}
        >
          {artifact ? (
            <CanvasDesignBody
              key={designPreviewKey(chatId, artifact.id, artifact.version)}
              artifact={artifact}
              files={pageFiles(chatId, artifact)}
              title={shown.title ?? "Design"}
              previewKey={designPreviewKey(chatId, artifact.id, artifact.version)}
              pixelRatio={pixelRatio}
              allowLive={allowLive}
              scale={scale}
              live={active || (liveZoom && inView) || artifact.format === "html"}
              mode={mode}
              onPainted={markPainted}
            />
          ) : (
            <div className="grid size-full place-items-center text-ink-3" style={{ fontSize: 24 }}>
              {error ?? "Loading…"}
            </div>
          )}
        </div>
        <LiveDesignLayer
          chatId={chatId}
          live={live}
          shown={artifact?.version ?? null}
          savedPainted={!!artifact && painted === artifact}
          width={width}
          height={height}
          scale={scale}
        />
        {!active && !commenting && <div data-slot="artifact-shield" aria-label={`Interact with ${shown.title}`} className="absolute inset-0 cursor-grab" />}
        {(commenting || framePins.length > 0 || sentPins.length > 0) && (
          <CommentLayer
            commenting={commenting}
            title={shown.title}
            onPin={(x, y) =>
              artifact &&
              comments.onPin(
                shown,
                x,
                y,
                artifact.format === "design" && artifact.document ? designNodeAt(artifact.document, x * width, y * height)?.id : undefined,
              )
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
      <InlineError size={12} className="max-w-full px-2">
        {editError}
      </InlineError>
      {exporting && artifact?.format === "design" && artifact.document && (
        <DesignExportDialog designs={[{ id: artifact.id, title: artifact.title, document: artifact.document }]} onClose={() => setExporting(false)} />
      )}
    </div>
  );
});
