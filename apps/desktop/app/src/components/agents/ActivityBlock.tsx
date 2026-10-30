import { useRef, useState } from "react";
import type { ComponentProps } from "react";
import { activityDuration, stepDisplayTitle } from "@milagre/shared/tool-activity";
import { useDisplayValue } from "../../lib/display-clock";
import { ActivitySources } from "./ActivitySource";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { ChatStep } from "../../model";
import { activitySummary, titleSpans } from "../../lib/reply-parts";
import type { ActivityEntry } from "../../lib/reply-parts";
import { activityBoundary, earlierStepsLabel } from "../../lib/activity-window";
import { useSettings } from "../../lib/settings";
import { useStepTitleSweep } from "../../lib/step-sweep";
import { Markdown } from "../markdown/Markdown";
import { StepRow } from "./StepRow";

const NO_WAITING_STEPS: string[] = [];

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 14 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

function Title({ step, running }: { step: ChatStep; running: boolean }) {
  const sweep = useStepTitleSweep(running);
  return (
    <>
      {titleSpans(stepDisplayTitle(step, running)).map((span, index) =>
        span.code ? (
          <code key={index} className={`rounded-[4px] bg-field px-1 py-px font-mono text-[0.92em] text-ink ${sweep.className ?? ""}`}>
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
  if (!entries.length) return null;
  if (toolCallDisplay === "full")
    return (
      <div data-slot="activity-inline" className="-mx-1.5 my-1 flex min-w-0 flex-col">
        {entries.map((entry, index) =>
          entry.type === "step" ? (
            <StepRow key={entry.step.id} step={entry.step} waiting={waitingStepIds.includes(entry.step.id)} />
          ) : (
            <div key={`text-${index}`} className="px-1.5 py-1.5">
              <Markdown text={entry.text} />
            </div>
          ),
        )}
      </div>
    );
  const first = entries[0];
  if (entries.length === 1 && first?.type === "step") return <StepRow key={first.step.id} step={first.step} waiting={waitingStepIds.includes(first.step.id)} />;

  const current = streaming
    ? (steps.find((step) => step.status === "running" && waitingStepIds.includes(step.id)) ?? steps.findLast((step) => step.status === "running"))
    : undefined;
  const waiting = current ? waitingStepIds.includes(current.id) : false;
  const summary = activitySummary(steps, { credits });

  return (
    <div data-slot="activity" className="-mx-1.5 my-1 flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (boundary === null) setBoundary(activityBoundary(entries, waitingStepIds, streaming));
          setOpen((value) => !value);
        }}
        className="flex w-fit max-w-full min-w-0 items-center gap-2 rounded-[8px] px-1.5 py-1 text-left text-[12.5px] leading-[1.4] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
      >
        <ActivitySources steps={steps} />
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
        {waiting && <span className="shrink-0 text-[11.5px] text-ink-3">Waiting for approval</span>}
        {summary.failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-red-ink">
            <Icon icon={Alert02Icon} size={13} />
            {summary.failed} failed
          </span>
        )}
        {streaming && <span className="shrink-0 text-[11.5px] text-ink-3">{steps.length} calls</span>}
        <span aria-hidden className={`shrink-0 text-ink-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
          <Icon icon={ArrowDown01Icon} size={12} />
        </span>
        {elapsed && <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">{elapsed}</span>}
      </button>

      <div
        inert={!open}
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
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
            className="relative mt-0.5 ml-[12px] border-l border-line pl-2 outline-none"
          >
            {hidden > 0 && (
              <button
                type="button"
                data-earlier-steps
                className="self-start rounded-control border border-line px-2 py-1 text-[12px] text-ink-2 hover:bg-hover"
                onClick={() => {
                  setBoundary(0);
                  body.current?.focus({ preventScroll: true });
                }}
              >
                {earlierStepsLabel(entries, hidden)}
              </button>
            )}
            {boundary !== null &&
              entries.slice(hidden).map((entry, index) =>
                entry.type === "step" ? (
                  <StepRow key={entry.step.id} step={entry.step} waiting={waitingStepIds.includes(entry.step.id)} />
                ) : (
                  <div key={`text-${hidden + index}`} className="px-1.5 py-1 text-[12.5px] leading-[1.55] text-ink-2">
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
