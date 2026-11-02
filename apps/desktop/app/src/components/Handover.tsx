import { useEffect, useRef, useState } from "react";
import type { HandoffContext, ModelOption } from "../model";
import { ArrowDataTransferHorizontalIcon } from "@hugeicons/core-free-icons";
import { handoffLabel } from "../lib/handover";
import { ProviderLogo } from "./ProviderLogo";
import { Markdown } from "./markdown/Markdown";
import { SpinnerRing } from "./primitives/SpinnerRing";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
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

/**
 * The brief the new provider was sent, or the linked summary a Link gave a Chat, in a Dialog with a Close bar.
 */
export function HandoffBriefDialog({ title, brief, onClose }: { title: string; brief: string; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

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

  return (
    <Dialog
      data-brief-dialog
      title={
        <span id="brief-dialog-title" className="block truncate">
          {title}
        </span>
      }
      width={680}
      onClose={onClose}
      footer="bar"
      actions={
        <Button data-brief-close onClick={onClose}>
          Close
        </Button>
      }
      className="pt-3"
    >
      <div data-brief-preview className="text-13 leading-5">
        <Markdown text={brief} />
      </div>
    </Dialog>
  );
}
