import { memo, useId, useState } from "react";
import type { ComponentProps } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { ChatStep } from "../../model";
import { stepDisplayTitle, stepDuration } from "@milagre/shared/tool-activity";
import { useDisplayValue } from "../../lib/display-clock";
import { fileSpanIndex } from "../../lib/file-links";
import { titleSpans } from "../../lib/reply-parts";
import { useSettings } from "../../lib/settings";
import { useStepTitleSweep } from "../../lib/step-sweep";
import { useFileOpener } from "../editor-links";
import { StepIcon } from "./ActivitySource";
import { StepOutput } from "./StepOutput";
import { Markdown } from "../markdown/Markdown";
import { ScrollArea } from "../primitives/ScrollArea";
import { useHasStepDetail, useStepDetail } from "./step-details";

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 14 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

function FileLink({ text, title, sweep, onOpen }: { text: string; title: string; sweep: { className?: string }; onOpen: () => void }) {
  const open = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onOpen();
  };
  return (
    <code
      role="link"
      tabIndex={0}
      title={title}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          open(event);
        }
      }}
      className={`pointer-events-auto cursor-pointer rounded-[4px] bg-field px-1 py-px font-mono text-[0.92em] text-ink decoration-ink-3 underline-offset-2 hover:underline ${sweep.className ?? ""}`}
    >
      {text}
    </code>
  );
}

/** One tool call in a reply: what it did and how it went. A row with output, a diff or thinking opens to show it. */
export const StepRow = memo(function StepRow({ step, waiting = false }: { step: ChatStep; waiting?: boolean }) {
  // Thinking follows Settings › Chat › Always expand reasoning until the row is toggled.
  const { expandReasoning } = useSettings();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (expandReasoning && step.kind === "thinking");
  const toggle = () => setToggled(!open);
  const detailId = useId();
  const running = step.status === "running";
  const title = stepDisplayTitle(step, running && !waiting);
  const duration = useDisplayValue(1000, (now) => stepDuration(step, now), running && step.startedAt != null);
  const opener = useFileOpener();
  // A read or edit's file opens in the editor from its name; the click doesn't toggle the row.
  const fileIndex = opener ? fileSpanIndex(step.title, step.file) : -1;
  const expandable = useHasStepDetail(step);
  const { detail, loading, failed, retry } = useStepDetail(step, open);
  // The title sweeps while the step runs; approval pauses it.
  const sweep = useStepTitleSweep(running && !waiting);
  // A finished tool just stops shimmering; screen readers hear only what isn't obvious.
  const state = waiting ? "Waiting for approval" : step.status === "running" ? "Running" : step.status === "failed" ? "Failed" : "";
  const rowClass = "flex w-full min-w-0 items-center gap-2 rounded-[8px] px-1.5 py-1 text-left text-[12.5px] leading-[1.4] text-ink-2";
  const outputStatus = (loading || failed) && (
    <div role="status" className="flex items-center gap-2 py-1 pl-7.5 text-[12px] text-ink-3">
      {loading ? "Loading output…" : "Could not load tool output."}
      {failed && (
        <button type="button" onClick={retry} className="rounded-control px-2 py-1 text-ink-2 hover:bg-hover">
          Try again
        </button>
      )}
    </div>
  );
  const content = (
    <>
      <span aria-hidden className="flex shrink-0 text-ink-2">
        <StepIcon step={step} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {titleSpans(title).map((span, index) =>
          index === fileIndex && opener && step.file ? (
            <FileLink key={index} text={span.text} title={opener.title} sweep={sweep} onOpen={() => opener.open(step.file!)} />
          ) : span.code ? (
            <code key={index} className={`rounded-[4px] bg-field px-1 py-px font-mono text-[0.92em] text-ink ${sweep.className ?? ""}`}>
              {span.text}
            </code>
          ) : (
            <span key={index} {...sweep}>
              {span.text}
            </span>
          ),
        )}
      </span>
      {step.status !== "running" && (step.summary || step.note) && (
        <span className={`max-w-[40%] shrink truncate text-[11.5px] ${step.status === "failed" ? "text-red-ink" : "text-ink-3"}`}>
          {step.summary || step.note}
        </span>
      )}
      {state && <span className="sr-only">{state}</span>}
      {waiting ? (
        <span aria-hidden className="shrink-0 text-[11.5px] text-ink-3">
          Waiting for approval
        </span>
      ) : step.status === "failed" ? (
        <span aria-hidden className="flex shrink-0 items-center gap-1 text-[11.5px] text-red-ink">
          <Icon icon={Alert02Icon} size={13} />
          {!step.summary && "Failed"}
        </span>
      ) : null}
      {expandable && (
        <span aria-hidden className={`shrink-0 text-ink-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
          <Icon icon={ArrowDown01Icon} size={12} />
        </span>
      )}
      {duration && <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">{duration}</span>}
    </>
  );
  return (
    <div data-slot="step" data-status={step.status} className="min-w-0">
      {expandable && fileIndex >= 0 ? (
        // The toggle covers the row and the file link sits above it, so no interactive element is nested in another.
        <div className="relative">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`${step.title.replace(/`/g, "")}${state ? `, ${state}` : ""}`}
            onClick={toggle}
            className="absolute inset-0 rounded-[8px] transition-colors hover:bg-hover"
          />
          <div className={`${rowClass} pointer-events-none relative`}>{content}</div>
        </div>
      ) : expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={toggle}
          className={`${rowClass} transition-colors hover:bg-hover hover:text-ink`}
        >
          {content}
        </button>
      ) : (
        <div className={rowClass}>{content}</div>
      )}
      {step.error && <div className="mb-1 ml-7 border-l-2 border-red/70 pl-2 font-mono text-[11.5px] leading-relaxed text-ink-2">{step.error}</div>}
      {open && (detail || step.input) ? (
        <ScrollArea id={detailId} chainScroll className="max-h-96 pl-6">
          {step.kind === "thinking" ? (
            <div className="px-1.5 py-1 text-[12.5px] leading-[1.55] text-ink-2">
              <Markdown text={detail ?? ""} />
            </div>
          ) : (
            <StepOutput step={step} detail={detail} />
          )}
          {outputStatus}
        </ScrollArea>
      ) : open && (loading || failed) ? (
        <div id={detailId}>{outputStatus}</div>
      ) : null}
    </div>
  );
});
