import { useLayoutEffect, useRef, useState } from "react";
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
import { SweepText } from "../primitives/SweepText";
import { lockToBeat } from "../../lib/beat";
import { CODE_CHIP, Markdown } from "../markdown/Markdown";
import { HOVER_FILL, StepRow } from "./StepRow";
import { InlineApproval, useStepApproval, useStepApprovalId, WaitingForApproval } from "./step-approval";
import { Icon } from "../primitives/Icon";
import { Button } from "../primitives/Button";

const NO_WAITING_STEPS: string[] = [];

export function ActivityTitle({ step, running, waiting = false, full = false }: { step: ChatStep; running: boolean; waiting?: boolean; full?: boolean }) {
  const sweep = useStepTitleSweep(running);
  return (
    <SweepText running={sweep.running} className="block min-w-0 truncate">
      {titleSpans(stepDisplayTitle(full ? step : { ...step, description: undefined, detail: undefined }, running, waiting)).map((span, index) =>
        span.code ? (
          <code key={index} className={`${CODE_CHIP} ${sweep.className ?? ""}`}>
            {span.text}
          </code>
        ) : (
          <span key={index} className={sweep.className}>
            {span.text}
          </span>
        ),
      )}
    </SweepText>
  );
}

export function ActivityBlock({
  entries,
  streaming = false,
  waitingStepIds = NO_WAITING_STEPS,
  credits,
}: {
  entries: ActivityEntry[];
  streaming?: boolean;
  waitingStepIds?: string[];
  credits?: number;
}) {
  const [open, setOpen] = useState(false);
  const [boundary, setBoundary] = useState<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) lockToBeat(body.current);
  }, [open]);
  const hidden = boundary === null ? 0 : activityBoundary(entries, waitingStepIds, streaming, boundary);
  if (boundary !== null && hidden < boundary) setBoundary(hidden);
  const { toolCallDisplay } = useSettings();
  const steps = entries.flatMap((entry): ChatStep[] => (entry.type === "step" ? [entry.step] : []));
  const elapsed = useDisplayValue(1000, (now) => activityDuration(steps, streaming, now), streaming);
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
      className={`group/fold flex h-6 w-full min-w-0 items-center gap-2 rounded-control px-[var(--row-inset,0px)] text-left text-12 text-ink-2 transition-colors hover:text-ink ${HOVER_FILL}`}
    >
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
            <ActivityTitle key={current.id} step={current} running={!waiting} waiting={waiting} />
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
        <InlineApproval approval={approval} title={stepDisplayTitle(current, false, true)}>
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
          <div ref={body} tabIndex={-1} data-slot="activity-body" role="group" aria-label="Activity" aria-live="off" className="relative mt-0.5 outline-none">
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
