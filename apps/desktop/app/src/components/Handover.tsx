import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { HandoffContext, ModelOption } from "../model";
import { ArrowDataTransferHorizontalIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { handoffLabel } from "../lib/handover";
import { ProviderLogo } from "./ProviderLogo";
import { Markdown } from "./markdown/Markdown";
import { ScrollArea } from "./primitives/ScrollArea";
import { SpinnerRing } from "./primitives/SpinnerRing";
import { Button, IconButton } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

/**
 * A provider switch inside the chat: a hairline with "Context handoff  Opus 5.5 → GPT-6" centred on it. It spins while
 * the brief is written, and opens the brief the new provider was sent.
 */
export function HandoffDivider({ context, models }: { context: HandoffContext; models: ModelOption[] }) {
  const [open, setOpen] = useState(false);
  const label = handoffLabel(context, models);
  const canOpen = context.status === "done" && Boolean(context.brief);
  return (
    <TranscriptDivider
      data-handoff-divider
      data-status={context.status}
      label={label.restored ? `Context restored to ${label.to}` : `Context handoff from ${label.from} to ${label.to}`}
    >
      {/* The visible text is the button's name; the ::before brings its hit area to 24px without growing the hairline row. */}
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen(true)}
        aria-haspopup={canOpen ? "dialog" : undefined}
        className="relative -mx-2 flex items-center gap-1.5 rounded-control px-2 py-0.5 transition-colors duration-fast before:absolute before:-inset-y-1 before:inset-x-0 enabled:hover:bg-hover enabled:hover:text-ink disabled:cursor-default"
      >
        {context.status === "preparing" ? <SpinnerRing size={12} /> : <Icon icon={ArrowDataTransferHorizontalIcon} size={12} />}
        <span>{label.restored ? "Context restored" : "Context handoff"}</span>
        {!label.restored && (
          <>
            <ProviderLogo provider={context.from.provider} size={12} />
            <span>{label.from}</span>
            <span aria-hidden="true">→</span>
          </>
        )}
        <ProviderLogo provider={context.to.provider} size={12} />
        <span className="font-medium text-ink-2">{label.to}</span>
        {context.status === "failed" && <span className="text-orange-ink">· Handoff failed</span>}
      </button>
      {open && context.brief && <HandoffBriefDialog title="Handoff brief" brief={context.brief} onClose={() => setOpen(false)} />}
    </TranscriptDivider>
  );
}

const FOCUSABLE = 'button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

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
      className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim p-4 backdrop-blur-overlay no-drag"
      style={{ animation: "fade-in var(--duration-fast) var(--ease-enter) both" }}
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
        className="flex h-[min(88vh,760px)] w-[680px] max-w-full flex-col overflow-hidden rounded-window bg-surface text-ink shadow-overlay outline-none"
        style={{ animation: "pop-in var(--duration-base) var(--ease-enter) both" }}
      >
        <header className="flex items-center gap-3 px-4 pt-4 pb-2">
          <h2 id="brief-dialog-title" className="min-w-0 flex-1 truncate text-17 font-semibold">
            {title}
          </h2>
          <IconButton label="Close" icon={Cancel01Icon} size={28} onClick={onClose} />
        </header>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-1">
          <ScrollArea data-brief-preview className="flex-1 text-13 leading-[1.55]">
            <Markdown text={brief} />
          </ScrollArea>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-inset px-4 py-3">
          <Button data-brief-close onClick={onClose}>
            Close
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
