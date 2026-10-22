import { useState } from "react";
import type { ComponentProps } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { ChatStep } from "../../model";
import { activitySummary, titleSpans } from "../../lib/reply-parts";
import type { ActivityEntry } from "../../lib/reply-parts";
import { useSettings } from "../../lib/settings";
import { Markdown } from "../markdown/Markdown";
import { StepRow } from "./StepRow";

const NO_WAITING_STEPS: string[] = [];

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 14 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

function Title({ title, shimmer }: { title: string; shimmer: boolean }) {
  return (
    <>
      {titleSpans(title).map((span, index) =>
        span.code ? (
          <code key={index} className={`rounded-[4px] bg-field px-1 py-px font-mono text-[0.92em] text-ink ${shimmer ? "step-shimmer" : ""}`}>
            {span.text}
          </code>
        ) : (
          <span key={index} className={shimmer ? "step-shimmer" : undefined}>
            {span.text}
          </span>
        ),
      )}
    </>
  );
}

/**
 * A reply's thinking, tool steps and the text between them, folded into one line. While the agent
 * works the line shows what it is doing now; once done it sums up the activity. It opens to show
 * every entry in order. A single step needs no fold and shows as its own row. Full detail (Settings › Chat ›
 * Tool call display) skips the fold: every step is its own row in the chat, with the text between them.
 */
export function ActivityBlock({
  entries,
  streaming = false,
  waitingStepIds = NO_WAITING_STEPS,
}: {
  entries: ActivityEntry[];
  streaming?: boolean;
  waitingStepIds?: string[];
}) {
  const [open, setOpen] = useState(false);
  const { toolCallDisplay } = useSettings();
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
  if (entries.length === 1 && first?.type === "step") return <StepRow step={first.step} waiting={waitingStepIds.includes(first.step.id)} />;

  const steps = entries.flatMap((entry): ChatStep[] => (entry.type === "step" ? [entry.step] : []));
  const current = streaming ? [...steps].reverse().find((step) => step.status === "running") : undefined;
  const waiting = current ? waitingStepIds.includes(current.id) : false;
  const summary = activitySummary(steps);

  return (
    <div data-slot="activity" className="-mx-1.5 my-1 flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit max-w-full min-w-0 items-center gap-2 rounded-[8px] px-1.5 py-1 text-left text-[12.5px] leading-[1.4] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
      >
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" className="shrink-0" fill={current ? "var(--ink-2)" : "var(--ink-3)"}>
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        <span role="status" className="min-w-0 truncate">
          {current ? <Title title={current.title} shimmer={!waiting} /> : summary.text}
        </span>
        {waiting && <span className="shrink-0 text-[11.5px] text-ink-3">Waiting for approval</span>}
        {!current && summary.failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-red">
            <Icon icon={Alert02Icon} size={13} />
            {summary.failed} failed
          </span>
        )}
        <span aria-hidden className={`shrink-0 text-ink-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
          <Icon icon={ArrowDown01Icon} size={12} />
        </span>
      </button>

      <div
        inert={!open}
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="relative mt-0.5 ml-[12px] border-l border-line pl-2">
            {entries.map((entry, index) =>
              entry.type === "step" ? (
                <StepRow key={entry.step.id} step={entry.step} waiting={waitingStepIds.includes(entry.step.id)} />
              ) : (
                <div key={`text-${index}`} className="px-1.5 py-1 text-[12.5px] leading-[1.55] text-ink-2">
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
