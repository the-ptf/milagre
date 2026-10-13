import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Cancel01Icon, FitToScreenIcon, MinusSignIcon, RedoIcon, UndoIcon } from "@hugeicons/core-free-icons";
import type { DesignArtifact as Artifact } from "@milagre/shared/artifact";
import type { DesignDocument } from "@milagre/shared/design";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../../lib/computer-bridge";
import { useDesignSharingAvailable } from "../../lib/design-sharing-available";
import { stateEvents } from "../../lib/state-events";
import Tooltip from "../primitives/Tooltip";
import { DESIGN_SAVED, DesignDocumentEditor, type DesignSaved } from "./DesignEditor";
import { DesignExportDialog } from "./DesignExportDialog";
import { DesignPageShareDialog } from "./DesignPageShareDialog";
import type { DesignEditorSession, DesignEditorWorkspace } from "./design-editor-session";

type View = { x: number; y: number; scale: number };
type ExportDesign = { id: string; title: string; document: DesignDocument };
const GAP = 80;
const MIN_SCALE = 0.025;
const MAX_SCALE = 3;
const clamp = (value: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
const iconButton =
  "flex size-8 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-35";
const textButton =
  "rounded-full px-3 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-35";
const dialogButton = "rounded-control border border-line px-3 py-1.5 text-[12px] hover:bg-hover disabled:opacity-40";
const isTextField = (element: Element | null) =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable);

/** Commit inspector text before a page action reads the current document sessions. */
function commitFocusedField() {
  const element = window.document.activeElement;
  if (isTextField(element)) flushSync(() => (element as HTMLElement).blur());
}

/** One Designs page: all artboards stay mounted while its shared tools inspect the active design. */
export function DesignPageEditor({
  chatId,
  artifact,
  latestVersion = artifact.latest,
  onClose,
}: {
  chatId: string;
  artifact: Artifact;
  latestVersion?: number;
  onClose: () => void;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([artifact]);
  const [versions, setVersions] = useState<Record<string, number>>({
    [artifact.id]: latestVersion,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [activeId, setActiveId] = useState(artifact.id);
  const [layersOpen, setLayersOpen] = useState(false);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [inspector, setInspector] = useState<HTMLDivElement | null>(null);
  const [notices, setNotices] = useState<HTMLDivElement | null>(null);
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const [revision, setRevision] = useState(0);
  const [pageSaving, setPageSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [sharing, setSharing] = useState(false);
  const sharingAvailable = useDesignSharingAvailable(chatId);
  const [exporting, setExporting] = useState<ExportDesign[] | null>(null);
  const [view, setView] = useState<View>({ x: 88, y: 72, scale: 0.5 });
  const [spacePanning, setSpacePanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const closeDialog = useRef<HTMLDialogElement>(null);
  const sessions = useRef(new Map<string, RefObject<DesignEditorSession | null>>());
  const loaded = useRef(new Set([artifact.id]));
  const moved = useRef(false);
  const working = useRef(false);
  const pan = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const current = useRef({
    onClose,
    sharing,
    exporting,
    confirmClose,
    pageSaving,
    activeId,
    view,
  });
  current.current = {
    onClose,
    sharing,
    exporting,
    confirmClose,
    pageSaving,
    activeId,
    view,
  };

  const notify = useCallback(() => setRevision((revision) => revision + 1), []);
  const register = useCallback(
    (id: string, session: RefObject<DesignEditorSession | null>) => {
      sessions.current.set(id, session);
      notify();
      return () => {
        if (sessions.current.get(id) === session) sessions.current.delete(id);
      };
    },
    [notify],
  );
  const activate = useCallback((id: string) => {
    commitFocusedField();
    setActiveId(id);
  }, []);
  const sessionList = useCallback(() => [...sessions.current.values()].flatMap((ref) => (ref.current ? [ref.current] : [])), []);
  const close = useCallback(() => {
    const state = current.current;
    if (working.current || state.pageSaving || state.sharing || state.exporting || state.confirmClose) return;
    commitFocusedField();
    if (sessionList().some((session) => session.saving)) return;
    if (sessionList().some((session) => session.dirty || session.pending)) setConfirmClose(true);
    else state.onClose();
  }, [sessionList]);

  const designs = useMemo(
    () =>
      artifacts.map((item) => {
        const session = sessions.current.get(item.id)?.current;
        return { id: item.id, title: session?.title ?? item.title, document: session?.document ?? item.document };
      }),
    [artifacts, revision],
  );
  const blocked = pageSaving || sharing || exporting !== null || confirmClose;
  const workspace = useMemo<DesignEditorWorkspace>(
    () => ({
      activeId,
      designs,
      layersOpen,
      setLayersOpen,
      blocked,
      scale: view.scale,
      root,
      inspector,
      notices,
      tools,
      activate,
      register,
      notify,
      close,
    }),
    [activeId, designs, layersOpen, blocked, view.scale, root, inspector, notices, tools, activate, register, notify, close],
  );
  const allSessions = sessionList();
  const active = sessions.current.get(activeId)?.current;
  const changed = allSessions.filter((session) => session.dirty || session.pending);
  const saving = pageSaving || allSessions.some((session) => session.saving);
  const canSave = changed.length > 0 && changed.every((session) => session.canSave) && !saving;
  useEffect(() => {
    if (!changed.length && !saving) setSaveError("");
  }, [changed.length, saving]);
  const shape = artifacts
    .map((item) => {
      const document = sessions.current.get(item.id)?.current?.document ?? item.document;
      return `${item.id}:${document.width}:${document.height}`;
    })
    .join("|");

  // Loading another artboard never replaces an already mounted draft. A newer version goes through its rebase flow.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError("");
    const api = bridgeForKey(chatId).artifacts;
    void api
      .list({ chatId })
      .then(async (rows) => {
        if (!live) return;
        const designs = rows.filter((row) => row.format === "design");
        setVersions((current) => {
          const next = { ...current };
          for (const row of designs) next[row.id] = Math.max(next[row.id] ?? 0, row.version);
          return next;
        });
        const missing = designs.filter((row) => !loaded.current.has(row.id));
        const results = await Promise.allSettled(missing.map((row) => api.get({ chatId, id: row.id })));
        if (!live) return;
        const added: Artifact[] = [];
        const failures: string[] = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled" && result.value.format === "design" && result.value.document) {
            loaded.current.add(result.value.id);
            added.push(result.value);
          } else {
            const reason = result.status === "rejected" ? ipcErrorMessage(result.reason) : "This design has no editable document.";
            failures.push(`${missing[index]!.title}: ${reason}`);
          }
        });
        if (added.length) setArtifacts((current) => [...current, ...added.filter((item) => !current.some((existing) => existing.id === item.id))]);
        if (failures.length) setLoadError(`Some designs could not be loaded. ${failures.join(" ")}`);
      })
      .catch((cause: unknown) => {
        if (live) setLoadError(`The Designs page could not be loaded. ${ipcErrorMessage(cause)}`);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [chatId, reload]);

  useEffect(() => {
    setVersions((current) => ({
      ...current,
      [artifact.id]: Math.max(current[artifact.id] ?? 0, latestVersion),
    }));
  }, [artifact.id, latestVersion]);
  useEffect(() => {
    const saved = (event: Event) => {
      const detail = (event as CustomEvent<DesignSaved>).detail;
      if (detail.chatId !== chatId || detail.artifact.format !== "design") return;
      const next = detail.artifact;
      setVersions((current) => ({
        ...current,
        [next.id]: Math.max(current[next.id] ?? 0, next.version),
      }));
      if (!loaded.current.has(next.id)) {
        loaded.current.add(next.id);
        setArtifacts((current) => [...current, next]);
      }
    };
    const off = stateEvents.onAgentEvent((update) => {
      if (update.chatId !== chatId) return;
      if (update.event.type === "turn-completed" || (update.event.type === "step-completed" && /^(Edited|Showed) /.test(update.event.title ?? "")))
        setReload((value) => value + 1);
    });
    window.addEventListener(DESIGN_SAVED, saved);
    return () => {
      window.removeEventListener(DESIGN_SAVED, saved);
      off();
    };
  }, [chatId]);

  const fit = useCallback(() => {
    const port = viewport.current;
    const content = board.current;
    if (!port || !content || !content.offsetWidth || !content.offsetHeight) return;
    const left = layersOpen ? 312 : 88;
    const right = 280;
    const top = 56;
    const bottom = 76;
    const width = Math.max(120, port.clientWidth - left - right);
    const height = Math.max(120, port.clientHeight - top - bottom);
    const scale = clamp(Math.min(width / content.offsetWidth, height / content.offsetHeight, 1));
    setView({
      scale,
      x: left + (width - content.offsetWidth * scale) / 2,
      y: top + (height - content.offsetHeight * scale) / 2,
    });
  }, [layersOpen]);
  useLayoutEffect(() => {
    if (!moved.current) fit();
  }, [shape, fit]);
  useLayoutEffect(() => {
    const port = viewport.current;
    if (!port) return;
    const observer = new ResizeObserver(() => {
      if (!moved.current) fit();
    });
    observer.observe(port);
    return () => observer.disconnect();
  }, [fit]);

  const zoomAt = useCallback((factor: number, x: number, y: number) => {
    moved.current = true;
    setView((current) => {
      const scale = clamp(current.scale * factor);
      return {
        scale,
        x: x - ((x - current.x) * scale) / current.scale,
        y: y - ((y - current.y) * scale) / current.scale,
      };
    });
  }, []);
  const zoom = (factor: number) => {
    const port = viewport.current;
    if (port) zoomAt(factor, (port.clientWidth + (layersOpen ? 312 : 88) - 280) / 2, port.clientHeight / 2);
  };
  useEffect(() => {
    const port = viewport.current;
    if (!port) return;
    const wheel = (event: WheelEvent) => {
      if (current.current.pageSaving || current.current.sharing || current.current.exporting || current.current.confirmClose) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = port.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      else {
        moved.current = true;
        setView((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
      }
    };
    port.addEventListener("wheel", wheel, { passive: false });
    return () => port.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  const saveAll = useCallback(async () => {
    if (working.current || sessionList().some((session) => session.saving)) return false;
    commitFocusedField();
    working.current = true;
    setPageSaving(true);
    setSaveError("");
    try {
      for (const session of sessionList()) {
        if (!session.dirty && !session.pending) continue;
        if (!session.canSave || !(await session.save())) {
          activate(session.id);
          setSaveError(`Review ${session.title} before saving the page. Your remaining drafts are still here.`);
          return false;
        }
      }
      return true;
    } catch (cause) {
      setSaveError(`The page could not be saved. ${ipcErrorMessage(cause)}`);
      return false;
    } finally {
      working.current = false;
      setPageSaving(false);
    }
  }, [activate, sessionList]);

  useEffect(() => {
    const previousFocus = window.document.activeElement as HTMLElement | null;
    root?.focus();
    return () => previousFocus?.focus();
  }, [root]);
  useEffect(() => {
    if (!confirmClose) return;
    const element = closeDialog.current;
    element?.showModal();
    return () => element?.close();
  }, [confirmClose]);
  useEffect(() => {
    const release = () => {
      setSpacePanning(false);
      setDragging(false);
      pan.current = null;
    };
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);

  const openExport = () => {
    if (loading || loadError || blocked || saving) return;
    commitFocusedField();
    setExporting(
      artifacts.map((item) => {
        const session = sessions.current.get(item.id)?.current;
        return {
          id: item.id,
          title: session?.title ?? item.title,
          document: session?.document ?? item.document,
        };
      }),
    );
  };
  const status = saving
    ? "Saving..."
    : changed.length
      ? `Unsaved changes${artifacts.length > 1 ? ` in ${changed.length} ${changed.length === 1 ? "design" : "designs"}` : ""}`
      : active
        ? `Saved · version ${active.saved.version}`
        : "Opening page...";

  return createPortal(
    <div
      ref={setRoot}
      data-slot="design-editor"
      data-focus-scope="design-editor"
      aria-label="Edit Designs page"
      tabIndex={-1}
      className="fixed inset-0 z-[55] overflow-hidden bg-canvas pt-10 text-ink outline-none"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => {
        if (blocked || (event.target instanceof Element && event.target.closest("dialog"))) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          event.stopPropagation();
          void saveAll();
        } else if (
          !isTextField(event.target as Element) &&
          !(event.target instanceof Element && event.target.closest("button, a, [role=button], [role=menuitem]")) &&
          event.code === "Space"
        ) {
          event.preventDefault();
          setSpacePanning(true);
        } else if (event.key === "Escape" && (event.target === root || event.target === viewport.current)) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onKeyUp={(event) => {
        if (event.code === "Space") setSpacePanning(false);
      }}
    >
      <div aria-hidden className="title-drag absolute inset-x-0 top-0 h-10" />
      <div className="pointer-events-none absolute left-6 right-[440px] top-[51px] min-w-0">
        <h1 className="text-[14px] font-medium">
          Designs{" "}
          <span className="ml-1.5 text-[11px] font-normal text-ink-3">
            {artifacts.length} {artifacts.length === 1 ? "design" : "designs"}
          </span>
        </h1>
        <p data-slot="design-save-status" aria-live="polite" className="mt-0.5 truncate text-[11px] text-ink-3">
          {status}
        </p>
      </div>
      <div
        role="toolbar"
        aria-label="Design page actions"
        data-slot="design-page-actions"
        className="absolute right-4 top-12 z-30 flex items-center gap-0.5 rounded-full border border-line bg-surface p-1.5 shadow-overlay"
      >
        <Tooltip label="Undo" shortcut="⌘Z" side="bottom">
          <button
            type="button"
            aria-label="Undo design edit"
            className={iconButton}
            disabled={blocked || saving || !active?.canUndo}
            onClick={() => active?.undo()}
          >
            <HugeiconsIcon icon={UndoIcon} size={17} strokeWidth={1.7} aria-hidden />
          </button>
        </Tooltip>
        <Tooltip label="Redo" shortcut="⌘⇧Z" side="bottom">
          <button
            type="button"
            aria-label="Redo design edit"
            className={iconButton}
            disabled={blocked || saving || !active?.canRedo}
            onClick={() => active?.redo()}
          >
            <HugeiconsIcon icon={RedoIcon} size={17} strokeWidth={1.7} aria-hidden />
          </button>
        </Tooltip>
        <span aria-hidden className="mx-1 h-4 border-l border-line" />
        {sharingAvailable && (
          <button
            type="button"
            aria-label="Share Designs page"
            className={textButton}
            disabled={blocked || saving || loading || !!loadError}
            onClick={() => setSharing(true)}
          >
            Share
          </button>
        )}
        <button type="button" aria-label="Export design" className={textButton} disabled={blocked || saving || loading || !!loadError} onClick={openExport}>
          Export
        </button>
        <button
          type="button"
          data-slot="design-save"
          className="ml-0.5 rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-35"
          disabled={blocked || !canSave}
          onClick={() => void saveAll()}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <span aria-hidden className="mx-1 h-4 border-l border-line" />
        <Tooltip label="Back to Milagre" side="bottom" align="end">
          <button type="button" aria-label="Close design editor" className={iconButton} disabled={blocked || saving} onClick={close}>
            <HugeiconsIcon icon={Cancel01Icon} size={17} strokeWidth={1.7} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <div className="absolute inset-x-0 bottom-0 top-24">
        <div
          ref={viewport}
          data-slot="design-page-viewport"
          tabIndex={-1}
          aria-label="Designs canvas"
          className={`absolute inset-0 overflow-hidden outline-none ${dragging ? "cursor-grabbing" : spacePanning ? "cursor-grab" : ""}`}
          style={{
            backgroundImage: "radial-gradient(var(--color-line) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            backgroundPosition: `${view.x % 24}px ${view.y % 24}px`,
          }}
          onPointerDown={(event) => {
            if (blocked || (event.button !== 0 && event.button !== 1)) return;
            const target = event.target as HTMLElement;
            if (event.button !== 1 && !spacePanning && target !== event.currentTarget && target !== board.current && !target.hasAttribute("data-pan-canvas"))
              return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            moved.current = true;
            const value = current.current.view;
            pan.current = {
              pointerId: event.pointerId,
              x: value.x,
              y: value.y,
              startX: event.clientX,
              startY: event.clientY,
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = pan.current;
            if (drag?.pointerId !== event.pointerId) return;
            setView((current) => ({
              ...current,
              x: drag.x + event.clientX - drag.startX,
              y: drag.y + event.clientY - drag.startY,
            }));
          }}
          onPointerUp={(event) => {
            if (pan.current?.pointerId !== event.pointerId) return;
            pan.current = null;
            setDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            pan.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            pan.current = null;
            setDragging(false);
          }}
        >
          <div
            ref={board}
            data-slot="design-page-board"
            className="absolute left-0 top-0 flex items-start"
            style={{
              width: "max-content",
              gap: GAP,
              transformOrigin: "0 0",
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            {artifacts.map((item) => (
              <DesignDocumentEditor
                key={item.id}
                chatId={chatId}
                artifact={item}
                latestVersion={versions[item.id] ?? item.latest}
                onClose={close}
                workspace={workspace}
              />
            ))}
          </div>
          {spacePanning && <div data-pan-canvas aria-hidden className="absolute inset-0 z-10" />}
        </div>
        <div ref={setTools} className="pointer-events-none absolute inset-0 z-20 [&>*]:pointer-events-auto" />
        <div
          data-slot="design-editor-notices"
          className="pointer-events-none absolute right-[280px] top-4 z-20 flex flex-col gap-2 [&>*]:pointer-events-auto"
          style={{ left: layersOpen ? 312 : 88 }}
        >
          {loadError && (
            <div role="alert" className="rounded-control border border-red/30 bg-surface p-3 text-[12px]">
              <p className="text-red">{loadError}</p>
              <button type="button" className={`${dialogButton} mt-2`} disabled={loading} onClick={() => setReload((value) => value + 1)}>
                Retry loading designs
              </button>
            </div>
          )}
          {loading && <p className="self-start rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] text-ink-3">Loading Designs page...</p>}
          {saveError && (
            <p role="alert" className="rounded-control border border-red/30 bg-surface p-3 text-[12px] text-red">
              {saveError}
            </p>
          )}
          <div ref={setNotices} className="flex flex-col overflow-hidden rounded-control bg-surface empty:hidden" />
        </div>
        <div
          ref={setInspector}
          data-slot="design-editor-inspector"
          className="absolute bottom-4 right-4 top-4 z-20 flex w-[248px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-overlay"
        />
        <div
          role="toolbar"
          aria-label="Canvas zoom"
          className="absolute bottom-5 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-surface p-1 shadow-overlay"
          style={{ left: layersOpen ? "calc(50% + 16px)" : "calc(50% - 96px)" }}
        >
          <Tooltip label="Zoom out">
            <button type="button" aria-label="Zoom out" className={iconButton} disabled={blocked || view.scale <= MIN_SCALE} onClick={() => zoom(1 / 1.25)}>
              <HugeiconsIcon icon={MinusSignIcon} size={16} aria-hidden />
            </button>
          </Tooltip>
          <span aria-live="polite" className="min-w-11 text-center text-[11px] tabular-nums text-ink-2">
            {Math.round(view.scale * 100)}%
          </span>
          <Tooltip label="Zoom in">
            <button type="button" aria-label="Zoom in" className={iconButton} disabled={blocked || view.scale >= MAX_SCALE} onClick={() => zoom(1.25)}>
              <HugeiconsIcon icon={Add01Icon} size={16} aria-hidden />
            </button>
          </Tooltip>
          <span aria-hidden className="mx-1 h-4 border-l border-line" />
          <Tooltip label="Fit page">
            <button
              type="button"
              aria-label="Fit Designs page"
              className={iconButton}
              disabled={blocked}
              onClick={() => {
                moved.current = false;
                fit();
              }}
            >
              <HugeiconsIcon icon={FitToScreenIcon} size={16} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>
      {confirmClose && (
        <dialog
          ref={closeDialog}
          aria-label="Unsaved design changes"
          data-slot="design-close-confirmation"
          onCancel={(event) => {
            event.preventDefault();
            if (!pageSaving) setConfirmClose(false);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget && !pageSaving) setConfirmClose(false);
          }}
          className="m-auto w-[420px] max-w-[calc(100vw-32px)] rounded-window border border-line bg-surface p-5 text-ink shadow-overlay backdrop:bg-black/30 backdrop:backdrop-blur-overlay"
        >
          <h2 className="text-[15px] font-semibold">Your changes have not been saved</h2>
          <p className="mt-2 text-[12px] leading-5 text-ink-3">Keep editing this page, or discard its unsaved changes and return to Milagre.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={dialogButton} onClick={() => setConfirmClose(false)}>
              Keep editing
            </button>
            <button
              type="button"
              className={`${dialogButton} border-red/30 text-red`}
              onClick={() => {
                for (const session of sessionList()) session.discard();
                current.current.onClose();
              }}
            >
              Discard changes
            </button>
          </div>
        </dialog>
      )}
      {sharing && <DesignPageShareDialog chatId={chatId} onClose={() => setSharing(false)} />}
      {exporting && <DesignExportDialog designs={exporting} onClose={() => setExporting(null)} />}
    </div>,
    window.document.body,
  );
}
