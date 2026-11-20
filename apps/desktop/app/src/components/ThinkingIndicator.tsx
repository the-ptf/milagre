import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChatStep } from "../model";
import { currentActivityStep } from "@milagre/shared/tool-activity";
import { activityBoundary, earlierStepsLabel } from "../lib/activity-window";
import { ActivityTitle } from "./agents/ActivityBlock";
import { StepRow } from "./agents/StepRow";
import { Button } from "./primitives/Button";
import { useLiveActivity } from "../lib/live-activity";
import { StepDetailsScope } from "./agents/step-details";
import { formatElapsed } from "@milagre/shared/display-clock";
import { useDisplayValue } from "../lib/display-clock";
import { backgroundLabel } from "@milagre/shared/chat-activity";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./primitives/Icon";
import { useStepTitleSweep } from "../lib/step-sweep";
import { SweepText } from "./primitives/SweepText";
import { lockToBeat } from "../lib/beat";

function RunningLogo() {
  return (
    <span ref={lockToBeat} data-beat aria-hidden className="running-logo relative inline-block size-4 shrink-0">
      <span className="running-logo-leg running-logo-leg-left">
        <svg viewBox="-4 -4 154 154" width="16" height="16">
          <path d="M49.6983 66.5562L21.6836 116.174C19.802 119.507 22.2098 123.632 26.0372 123.632H39.9727L54.9727 100.132L66.9727 119.632L51.9727 144.132H26.0372C6.24066 144.132 -6.29344 122.89 3.27837 105.561L30.9405 55.4819L49.6983 66.5562Z" />
        </svg>
      </span>
      <span className="running-logo-leg running-logo-leg-right">
        <svg viewBox="-4 -4 154 154" width="16" height="16">
          <path d="M142.666 105.561C152.238 122.89 139.704 144.132 119.907 144.132H93.9728L78.9728 119.632L90.9728 100.132L105.973 123.632H119.907C123.735 123.632 126.143 119.507 124.261 116.174L96.2462 66.5562L115.004 55.4819L142.666 105.561Z" />
        </svg>
      </span>
      <span className="running-logo-star">
        <svg viewBox="-4 -4 154 154" width="16" height="16">
          <path d="M69.528 1.96636C71.0759 -0.655453 74.869 -0.655453 76.4169 1.96636L91.0103 26.6837C91.3538 27.2656 91.8392 27.751 92.4211 28.0945L117.138 42.6879C119.76 44.2358 119.76 48.0289 117.138 49.5768L92.4211 64.1702C91.8392 64.5137 91.3538 64.9991 91.0103 65.581L76.4169 90.2983C74.869 92.9201 71.0759 92.9201 69.528 90.2983L54.9347 65.581C54.5911 64.9991 54.1057 64.5137 53.5238 64.1702L28.8065 49.5768C26.1847 48.0289 26.1847 44.2358 28.8065 42.6879L53.5238 28.0945C54.1057 27.751 54.5911 27.2656 54.9347 26.6837L69.528 1.96636Z" />
        </svg>
      </span>
    </span>
  );
}

function useElapsed(startedAt?: number) {
  const [mountedAt] = useState(() => Date.now());
  return useDisplayValue(250, (now) => formatElapsed(now - (startedAt ?? mountedAt)));
}

function ThinkingIndicator({
  label,
  showLabel = false,
  startedAt,
  steps = NO_STEPS,
}: {
  label: string;
  showLabel?: boolean;
  startedAt?: number;
  steps?: ChatStep[];
}) {
  const elapsed = useElapsed(startedAt);
  const sweep = useStepTitleSweep(showLabel);
  const [open, setOpen] = useState(false);
  if (steps.length && !showLabel)
    return (
      <div className="flex min-w-0 flex-col">
        {open && <LiveSteps steps={steps} />}
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${label}. ${open ? "Hide" : "Show"} running calls`}
          onClick={() => setOpen((value) => !value)}
          data-live-activity={steps.length}
          className="group/live flex w-fit max-w-full min-w-0 items-center gap-2 rounded-control py-1 pr-1.5 pl-[var(--row-inset,0px)] text-left text-12 text-ink-3 transition-colors duration-fast hover:bg-hover"
        >
          <RunningLogo />
          <LiveTitle steps={steps} />
          {!allRunning(steps) && (
            <>
              <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-ink-4" />
              <span className="shrink-0">{steps.length === 1 ? "1 call" : `${steps.length} calls`}</span>
            </>
          )}
          <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-ink-4" />
          <span className="shrink-0 tabular-nums">{elapsed}</span>
          <Icon
            icon={ArrowDown01Icon}
            size={12}
            className={`shrink-0 transition-[color,rotate] duration-base ease-enter group-hover/live:text-ink ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>
    );

  return (
    <div role="status" aria-label={label} className="flex w-fit items-center gap-2 py-1 pr-1 pl-[var(--row-inset,0px)]">
      <RunningLogo />
      {showLabel && (
        <SweepText aria-hidden running={sweep.running} className={`min-w-0 truncate text-12 text-ink-3 ${sweep.className ?? ""}`}>
          {label}
        </SweepText>
      )}
      <span aria-hidden className="text-12 tabular-nums text-ink-3">
        {elapsed}
      </span>
    </div>
  );
}

export function RunIndicator({
  run,
  ...indicator
}: {
  run: { key?: string; text?: string; steps?: ChatStep[]; waitingStepIds?: string[]; scope?: string };
  label: string;
  showLabel?: boolean;
  startedAt?: number;
}) {
  const steps = useLiveActivity(run.key, run.text, run.steps, run.waitingStepIds ?? NO_WAITING);
  return (
    <div className="w-full" style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}>
      <StepDetailsScope scope={run.scope}>
        <ThinkingIndicator {...indicator} steps={steps} />
      </StepDetailsScope>
    </div>
  );
}

const NO_STEPS: ChatStep[] = [];
const allRunning = (steps: ChatStep[]) => steps.length > 1 && steps.every((step) => step.status === "running");
const NO_WAITING: string[] = [];

function LiveTitle({ steps }: { steps: ChatStep[] }) {
  const running = steps.filter((step) => step.status === "running").length;
  const current = currentActivityStep(steps) ?? steps.at(-1);
  return (
    <span role="status" className="min-w-0 truncate text-ink-2">
      {running > 1 ? `Running ${running} calls` : current && <ActivityTitle key={current.id} step={current} running={current.status === "running"} full />}
    </span>
  );
}

function LiveSteps({ steps }: { steps: ChatStep[] }) {
  const entries = steps.map((step) => ({ type: "step" as const, step }));
  const [boundary, setBoundary] = useState(() => activityBoundary(entries, NO_WAITING, true));
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => lockToBeat(body.current), []);
  return (
    <div
      ref={body}
      tabIndex={-1}
      role="group"
      aria-label="Running calls"
      aria-live="off"
      data-slot="activity-body"
      className="flex min-w-0 flex-col outline-none"
    >
      {boundary > 0 && (
        <Button
          variant="secondary"
          size={24}
          className="ml-[var(--row-inset,0px)] self-start"
          onClick={() => {
            setBoundary(0);
            body.current?.focus({ preventScroll: true });
          }}
        >
          {earlierStepsLabel(entries, boundary)}
        </Button>
      )}
      {steps.slice(boundary).map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
    </div>
  );
}

export function BackgroundIndicator({
  count,
  startedAt,
  mark,
  onClick,
  expanded,
}: {
  count: number;
  startedAt?: number;
  mark: ReactNode;
  onClick: () => void;
  expanded: boolean;
}) {
  const elapsed = useElapsed(startedAt);
  const label = `${backgroundLabel(count)} running`;
  return (
    <button
      type="button"
      aria-label={`${label}. Show background tasks`}
      aria-expanded={expanded}
      onClick={onClick}
      data-background-work={count}
      className="flex w-fit max-w-full items-center gap-2 rounded-control px-1 py-1 text-left text-12 text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-ink"
    >
      {mark}
      <span aria-hidden className="min-w-0 truncate">
        {label}
      </span>
      <span aria-hidden className="tabular-nums text-ink-3">
        {elapsed}
      </span>
      <Icon icon={ArrowDown01Icon} size={12} className={`shrink-0 text-ink-3 transition-transform duration-fast ${expanded ? "rotate-180" : ""}`} />
    </button>
  );
}
