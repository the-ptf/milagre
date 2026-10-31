import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Tick02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { isModalOpen } from "../../lib/modal";
import { isMac } from "../../lib/shortcut-hints";
import { undoHistory, undoKey, type ToastKind, type UndoToast } from "../../lib/undo-history";

const TOAST_MS = 6000;
const SHORTCUTS = isMac ? { undo: "⌘Z", redo: "⇧⌘Z" } : { undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };

/**
 * The sidebar's toast, just above the usage meters, and the ⌘Z / ⇧⌘Z that walk its undo history. Mounted where it
 * sits in the sidebar's column; with the sidebar collapsed to its rail it floats beside it instead.
 */
export function SidebarToast({ collapsed }: { collapsed: boolean }) {
  const toast = useSyncExternalStore(undoHistory.subscribe, undoHistory.toast);
  const anchor = useRef<HTMLDivElement>(null);
  const [beside, setBeside] = useState<number | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => undoHistory.dismiss(toast.id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const step = undoKey(event, isMac);
      if (!step || document.documentElement.hasAttribute("data-popover-open") || isModalOpen()) return;
      if (step === "undo" ? undoHistory.undo() : undoHistory.redo()) event.preventDefault();
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, []);

  useLayoutEffect(() => {
    if (toast && collapsed) setBeside((anchor.current?.closest("aside")?.getBoundingClientRect().right ?? 0) + 12);
  }, [toast, collapsed]);

  if (!toast) return <div ref={anchor} className="relative h-0 shrink-0" />;
  const pill = <ToastPill toast={toast} />;
  return (
    <div ref={anchor} className="relative h-0 shrink-0">
      {collapsed ? (
        beside !== null &&
        createPortal(
          <div className="fixed bottom-4 z-[80] w-[300px]" style={{ left: beside }}>
            {pill}
          </div>,
          document.body,
        )
      ) : (
        <div className="absolute inset-x-3 bottom-1.5 z-20">{pill}</div>
      )}
    </div>
  );
}

function ToastPill({ toast }: { toast: UndoToast }) {
  const shortcut = toast.button && SHORTCUTS[toast.button];
  return (
    <div
      key={toast.id}
      role="status"
      aria-live="polite"
      data-chat-toast
      className="@container flex min-h-11 w-full items-center gap-2.5 rounded-full bg-ink py-2 pl-3.5 pr-4 text-13 font-semibold text-surface shadow-overlay"
      style={{ animation: "fade-up 200ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {toast.kind && <ToastIcon kind={toast.kind} />}
      <span className="min-w-0 flex-1">{toast.text}</span>
      {toast.button && (
        <button
          type="button"
          {...(toast.button === "undo" ? { "data-chat-toast-undo": "" } : { "data-chat-toast-redo": "" })}
          aria-keyshortcuts={isMac ? (toast.button === "undo" ? "Meta+Z" : "Shift+Meta+Z") : toast.button === "undo" ? "Control+Z" : "Control+Shift+Z"}
          onClick={() => (toast.button === "undo" ? undoHistory.undo() : undoHistory.redo())}
          className="relative flex shrink-0 items-center gap-2 transition-opacity before:absolute before:-inset-2 hover:opacity-80 active:scale-[0.97]"
        >
          {toast.button === "undo" ? "Undo" : "Redo"}
          {/* The key hint gives way first in a narrow sidebar, so the label stays on one line. */}
          <span aria-hidden className="hidden font-medium tabular-nums opacity-60 @[15rem]:inline">
            {shortcut}
          </span>
        </button>
      )}
    </div>
  );
}

/** Done's check sits in a solid badge so it reads at a glance; the rest are line icons in the label colour. */
function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === "done")
    return (
      <span className="grid size-[18px] shrink-0 place-items-center rounded-full bg-surface text-ink">
        <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2.6} color="currentColor" />
      </span>
    );
  return <HugeiconsIcon icon={kind === "deleted" ? Delete02Icon : Undo02Icon} size={16} strokeWidth={1.8} color="currentColor" className="shrink-0" />;
}
