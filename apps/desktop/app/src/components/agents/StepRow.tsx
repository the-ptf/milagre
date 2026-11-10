import { memo, useId, useState } from "react";
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
import { CODE_CHIP, Markdown } from "../markdown/Markdown";
import { ScrollArea } from "../primitives/ScrollArea";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import Tooltip from "../primitives/Tooltip";
import { useHasStepDetail, useStepDetail } from "./step-details";
import { InlineApproval, useStepApproval, WaitingForApproval } from "./step-approval";

function FileLink({ text, title, sweep, onOpen }: { text: string; title: string; sweep: { className?: string }; onOpen: () => void }) {
  const open = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onOpen();
  };
  return (
    <Tooltip label={title} asChild>
      <code
        role="link"
        tabIndex={0}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            open(event);
          }
        }}
        className={`${CODE_CHIP} pointer-events-auto cursor-pointer decoration-ink-3 underline-offset-2 hover:underline ${sweep.className ?? ""}`}
      >
        {text}
      </code>
    </Tooltip>
  );
}

/** One tool call in a reply: what it did and how it went. A row with output, a diff or thinking opens to show it. */
/** The row hover fill, drawn behind the content so it can reach --row-bleed past the column edges. */
export const HOVER_FILL =
  "relative isolate before:absolute before:inset-y-0 before:-inset-x-[var(--row-bleed,13px)] before:-z-10 before:rounded-control before:transition-colors hover:before:bg-hover";

export const StepRow = memo(function StepRow({
  step,
  waiting = false,
  hostsApproval = true,
}: {
  step: ChatStep;
  waiting?: boolean;
  /** Show the step's approval on this row (false where an enclosing fold's line shows it). */
  hostsApproval?: boolean;
}) {
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
  // Waiting on the user: Deny, Always allow and Allow once sit right under this row.
  const approval = useStepApproval(waiting && hostsApproval ? step.id : undefined);
  // The title sweeps while the step runs; approval pauses it.
  const sweep = useStepTitleSweep(running && !waiting);
  // A finished tool just stops shimmering; screen readers hear only what isn't obvious.
  const state = waiting ? "Waiting for approval" : step.status === "running" ? "Running" : step.status === "failed" ? "Failed" : "";
  // Every tool row's glyph starts on the reply text's edge and its time ends on the column's right edge; the hover fill
  // reaches 13px past both (--row-bleed). A bordered block sets --row-inset to 12px and --row-bleed to 0 for its rows.
  const rowClass = "flex h-6 w-full min-w-0 items-center gap-2 rounded-control px-[var(--row-inset,0px)] text-left text-12 text-ink-2";
  const outputStatus = (loading || failed) && (
    <div role="status" className="flex items-center gap-2 py-1 pl-[calc(var(--row-inset,0px)+22px)] text-12 text-ink-3">
      {loading ? "Loading output…" : "Could not load tool output."}
      {failed && (
        <Button variant="ghost" size={24} onClick={retry}>
          Try again
        </Button>
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
            <code key={index} className={`${CODE_CHIP} ${sweep.className ?? ""}`}>
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
        <span className={`max-w-[40%] shrink truncate text-11 ${step.status === "failed" ? "text-red-ink" : "text-ink-3"}`}>{step.summary || step.note}</span>
      )}
      {state && <span className="sr-only">{state}</span>}
      {waiting ? (
        <WaitingForApproval />
      ) : step.status === "failed" ? (
        <span aria-hidden className="flex shrink-0 items-center gap-1 text-11 text-red-ink">
          <Icon icon={Alert02Icon} size={12} />
          {!step.summary && "Failed"}
        </span>
      ) : null}
      {expandable ? (
        <span aria-hidden className={`shrink-0 text-ink-3 transition-transform duration-base ease-enter ${open ? "rotate-180" : ""}`}>
          <Icon icon={ArrowDown01Icon} size={12} />
        </span>
      ) : (
        // An empty chevron slot, so a row without detail keeps its note and time in the same columns as its neighbours.
        duration && <span aria-hidden className="w-3 shrink-0" />
      )}
      {duration && <span className="min-w-10 shrink-0 text-right text-11 text-ink-3 tabular-nums">{duration}</span>}
    </>
  );
  const row =
    expandable && fileIndex >= 0 ? (
      // The toggle covers the row and the file link sits above it, so no interactive element is nested in another.
      <div className="relative">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={`${step.title.replace(/`/g, "")}${state ? `, ${state}` : ""}`}
          onClick={toggle}
          className="absolute inset-y-0 -inset-x-[var(--row-bleed,13px)] rounded-control transition-colors hover:bg-hover"
        />
        <div className={`${rowClass} pointer-events-none relative`}>{content}</div>
      </div>
    ) : expandable ? (
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={toggle}
        className={`${rowClass} ${HOVER_FILL} transition-colors hover:text-ink`}
      >
        {content}
      </button>
    ) : (
      <div className={rowClass}>{content}</div>
    );
  return (
    <div data-slot="step" data-status={step.status} className="min-w-0">
      {approval ? (
        <InlineApproval approval={approval} title={title}>
          {row}
        </InlineApproval>
      ) : (
        row
      )}
      {step.error && (
        <div className="mb-1 ml-[calc(var(--row-inset,0px)+22px)] border-l-2 border-red pl-2 font-mono text-11 leading-relaxed text-ink-2">{step.error}</div>
      )}
      {open && (detail || step.input) ? (
        // Output frames (a diff, a code block) sit on the column's edges, like the transcript's other blocks.
        <ScrollArea id={detailId} chainScroll className="max-h-96">
          {step.kind === "thinking" ? (
            <div className="px-[var(--row-inset,0px)] py-1 text-12 leading-[1.55] text-ink-2">
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
