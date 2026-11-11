import { useRef, useState } from "react";
import { activityDuration, stepDisplayTitle } from "@milagre/shared/tool-activity";
import { useDisplayValue } from "../../lib/display-clock";
import { ActivitySources, StepIcon } from "./ActivitySource";
import { Alert02Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { ChatStep } from "../../model";
import { activitySummary, titleSpans } from "../../lib/reply-parts";
import type { ActivityEntry } from "../../lib/reply-parts";
import { activityBoundary, earlierStepsLabel } from "../../lib/activity-window";
import { useSettings } from "../../lib/settings";
import { useStepTitleSweep } from "../../lib/step-sweep";
import { CODE_CHIP, Markdown } from "../markdown/Markdown";
import { HOVER_FILL, StepRow } from "./StepRow";
import { InlineApproval, useStepApproval, useStepApprovalId, WaitingForApproval } from "./step-approval";
import { Icon } from "../primitives/Icon";
import { Button } from "../primitives/Button";

const NO_WAITING_STEPS: string[] = [];

function Title({ step, running }: { step: ChatStep; running: boolean }) {
  const sweep = useStepTitleSweep(running);
  return (
    <>
      {titleSpans(stepDisplayTitle({ ...step, description: undefined, detail: undefined }, running)).map((span, index) =>
        span.code ? (
          <code key={index} className={`${CODE_CHIP} ${sweep.className ?? ""}`}>
            {span.text}
          </code>
        ) : (
          <span key={index} {...sweep}>
            {span.text}
          </span>
        ),
      )}
    </>
  );
}

/**
 * A reply's thinking, tool steps and the text between them, folded into one line. While the agent
 * works the line shows what it is doing now; once done it sums up the activity. Rows mount on first
 * open, with earlier entries in long replies behind a reveal button. A single step needs no fold.
 * Full detail (Settings › Chat › Tool call display) skips the fold: every step is its own row in the chat, with the text between them.
 */
export function ActivityBlock({
  entries,
  streaming = false,
  waitingStepIds = NO_WAITING_STEPS,
  credits,
}: {
  entries: ActivityEntry[];
  streaming?: boolean;
  waitingStepIds?: string[];
  /** What the turn cost (Kiro's credits), shown at the end of the summary. */
  credits?: number;
}) {
  const [open, setOpen] = useState(false);
  // Null until first opened; mounted rows and their output state survive later collapses.
  const [boundary, setBoundary] = useState<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const hidden = boundary === null ? 0 : activityBoundary(entries, waitingStepIds, streaming, boundary);
  // An earlier step can resume or need approval. Reveal it permanently, without evicting rows.
  if (boundary !== null && hidden < boundary) setBoundary(hidden);
  const { toolCallDisplay } = useSettings();
  const steps = entries.flatMap((entry): ChatStep[] => (entry.type === "step" ? [entry.step] : []));
  const elapsed = useDisplayValue(1000, (now) => activityDuration(steps, streaming, now), streaming);
  // The step waiting on the approval the transcript shows leads the line, so its Deny and Allow sit under its name.
  const approvalStepId = useStepApprovalId();
  const current = streaming
    ? (steps.find((step) => step.status === "running" && step.id === approvalStepId && waitingStepIds.includes(step.id)) ??
      steps.find((step) => step.status === "running" && waitingStepIds.includes(step.id)) ??
      steps.findLast((step) => step.status === "running"))
    : undefined;
  const waiting = current ? waitingStepIds.includes(current.id) : false;
  const folded = toolCallDisplay !== "full" && !(entries.length === 1 && entries[0]?.type === "step");
  const approval = useStepApproval(folded && waiting ? current?.id : undefined);
  if (!entries.length) return null;
  if (toolCallDisplay === "full")
    return (
      <div data-slot="activity-inline" className="my-1 flex min-w-0 flex-col">
        {entries.map((entry, index) =>
          entry.type === "step" ? (
            <StepRow key={entry.step.id} step={entry.step} waiting={waitingStepIds.includes(entry.step.id)} />
          ) : (
            <div key={`text-${index}`} className="py-1.5">
              <Markdown text={entry.text} />
            </div>
          ),
        )}
      </div>
    );
  const first = entries[0];
  if (entries.length === 1 && first?.type === "step") return <StepRow key={first.step.id} step={first.step} waiting={waitingStepIds.includes(first.step.id)} />;

  const summary = activitySummary(steps, { credits });

  const line = (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => {
        if (boundary === null) setBoundary(activityBoundary(entries, waitingStepIds, streaming));
        setOpen((value) => !value);
      }}
      // The whole line is the toggle, with time and chevron immediately after its content.
      className={`group/fold flex h-6 w-full min-w-0 items-center gap-2 rounded-control px-[var(--row-inset,0px)] text-left text-12 text-ink-2 transition-colors hover:text-ink ${HOVER_FILL}`}
    >
      {/* A waiting line is about one call: its glyph alone, not the reply's mix. */}
      {waiting && current ? (
        <span aria-hidden className="flex shrink-0 text-ink-3">
          <StepIcon step={current} />
        </span>
      ) : (
        <ActivitySources steps={steps} />
      )}
      <span role="status" className="min-w-0 truncate">
        {current ? (
          steps.filter((step) => step.status === "running").length > 1 && !waiting ? (
            `Running ${steps.filter((step) => step.status === "running").length} calls`
          ) : (
            <Title key={current.id} step={current} running={!waiting} />
          )
        ) : streaming ? (
          "Working"
        ) : (
          summary.text
        )}
      </span>
      {waiting && <WaitingForApproval />}
      {summary.failed > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-11 text-red-ink">
          <Icon icon={Alert02Icon} size={12} />
          {summary.failed} failed
        </span>
      )}
      {streaming && !waiting && <span className="shrink-0 text-11 text-ink-3">{steps.length} calls</span>}
      {elapsed && <span className="shrink-0 text-11 text-ink-3 tabular-nums transition-colors group-hover/fold:text-ink-2">{elapsed}</span>}
      <span
        aria-hidden
        className={`shrink-0 text-ink-3 transition-[color,rotate,transform] duration-base ease-enter group-hover/fold:text-ink ${open ? "rotate-180" : ""}`}
      >
        <Icon icon={ArrowDown01Icon} size={12} />
      </span>
    </button>
  );

  return (
    <div data-slot="activity" className="my-1 flex min-w-0 flex-col">
      {approval && current ? (
        <InlineApproval approval={approval} title={stepDisplayTitle(current, false)}>
          {line}
        </InlineApproval>
      ) : (
        line
      )}

      <div
        inert={!open}
        className="grid transition-[grid-template-rows,opacity] duration-slow ease-enter"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="min-w-0 overflow-hidden">
          <div
            ref={body}
            tabIndex={-1}
            data-slot="activity-body"
            role="group"
            aria-label="Activity"
            aria-live="off"
            // The open fold's rows keep the summary's glyph line: one inset line for every tool row.
            className="relative mt-0.5 outline-none"
          >
            {hidden > 0 && (
              <Button
                variant="secondary"
                size={24}
                data-earlier-steps
                className="ml-[var(--row-inset,0px)] self-start"
                onClick={() => {
                  setBoundary(0);
                  body.current?.focus({ preventScroll: true });
                }}
              >
                {earlierStepsLabel(entries, hidden)}
              </Button>
            )}
            {boundary !== null &&
              entries.slice(hidden).map((entry, index) =>
                entry.type === "step" ? (
                  <StepRow key={entry.step.id} step={entry.step} waiting={waitingStepIds.includes(entry.step.id)} hostsApproval={!approval} />
                ) : (
                  <div key={`text-${hidden + index}`} className="px-[var(--row-inset,0px)] py-1 text-12 leading-[1.55] text-ink-2">
                    <Markdown text={entry.text} />
                  </div>
                ),
              )}
          </div>
        </div>
      </div>
    </div>
  );
}
