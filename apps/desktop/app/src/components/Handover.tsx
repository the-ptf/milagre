import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { HandoffContext, ModelOption } from "../model";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDataTransferHorizontalIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { handoffLabel } from "../lib/handover";
import { ProviderLogo } from "./ProviderLogo";
import { Markdown } from "./markdown/Markdown";
import { ScrollArea } from "./primitives/ScrollArea";
import { SpinnerRing } from "./primitives/SpinnerRing";

/**
 * A provider switch inside the chat: a hairline with "Context handoff  Opus 5.5 → GPT-6" centred on it. It spins while
 * the brief is written, and opens the brief the new provider was sent.
 */
export function HandoffDivider({ context, models }: { context: HandoffContext; models: ModelOption[] }) {
  const [open, setOpen] = useState(false);
  const label = handoffLabel(context, models);
  const canOpen = context.status === "done" && Boolean(context.brief);
  return (
    <div
      data-handoff-divider
      data-status={context.status}
      className="flex w-full items-center gap-3 py-1 text-[12px] text-ink-3"
      role="group"
      aria-label={label.restored ? `Context restored to ${label.to}` : `Context handoff from ${label.from} to ${label.to}`}
    >
      <span className="h-px flex-1 bg-line" />
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen(true)}
        aria-label={canOpen ? "Open the handoff brief" : undefined}
        className="flex items-center gap-1.5 rounded-control px-2 py-0.5 enabled:hover:bg-hover enabled:hover:text-ink disabled:cursor-default"
      >
        {context.status === "preparing" ? (
          <SpinnerRing size={12} />
        ) : (
          <HugeiconsIcon icon={ArrowDataTransferHorizontalIcon} size={13} strokeWidth={1.8} color="currentColor" />
        )}
        <span>{label.restored ? "Context restored" : "Context handoff"}</span>
        {!label.restored && (
          <>
            <ProviderLogo provider={context.from.provider} size={13} />
            <span>{label.from}</span>
            <span aria-hidden="true">→</span>
          </>
        )}
        <ProviderLogo provider={context.to.provider} size={13} />
        <span className="font-medium text-ink-2">{label.to}</span>
        {context.status === "failed" && <span className="text-orange-ink">· Handoff failed</span>}
      </button>
      <span className="h-px flex-1 bg-line" />
      {open && context.brief && <HandoffBriefDialog title="Handoff brief" brief={context.brief} onClose={() => setOpen(false)} />}
    </div>
  );
}

const FOCUSABLE = 'button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const BUTTON_PRIMARY =
  "inline-flex h-8 items-center gap-1.5 rounded-control bg-ink px-3 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-40";

/**
 * The brief the new provider was sent, or the linked summary a Link gave a Chat, in a modal as the GitActionsDialog is
 * built: a Preview with Close.
 */
export function HandoffBriefDialog({ title, brief, onClose }: { title: string; brief: string; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Focus moves into the dialog, and back to where it was when the dialog closes.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Escape closes the dialog wherever focus is, and is consumed here so it doesn't also stop the chat's turn.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Tab and Shift+Tab stay inside the dialog.
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((element) => element.offsetParent !== null);
    if (!focusable.length) return event.preventDefault();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === panelRef.current)) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      data-brief-dialog-overlay
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[oklch(0.2_0.01_260/0.32)] p-4 [-webkit-app-region:no-drag]"
      style={{ animation: "fade-in 140ms ease-out both" }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="brief-dialog-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        data-brief-dialog
        className="flex h-[min(88vh,760px)] w-[680px] max-w-full flex-col overflow-hidden rounded-[14px] bg-surface text-ink shadow-overlay outline-none"
        style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <header className="flex items-center gap-3 px-4 pb-2 pt-3.5">
          <h2 id="brief-dialog-title" className="min-w-0 flex-1 truncate text-[15px] font-semibold">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.8} color="currentColor" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-1">
          <ScrollArea data-brief-preview className="flex-1 text-[13px] leading-[1.55]">
            <Markdown text={brief} />
          </ScrollArea>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-inset px-4 py-3">
          <button type="button" data-brief-close className={BUTTON_PRIMARY} onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
