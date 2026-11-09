import { useState, type ReactNode } from "react";
import { formatElapsed } from "@milagre/shared/display-clock";
import { useDisplayValue } from "../lib/display-clock";
import { backgroundLabel } from "@milagre/shared/chat-activity";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./primitives/Icon";
import { SpinnerRing } from "./primitives/SpinnerRing";

function useElapsed(startedAt?: number) {
  const [mountedAt] = useState(() => Date.now());
  return useDisplayValue(250, (now) => formatElapsed(now - (startedAt ?? mountedAt)));
}

/** The turn running and how long it has run. The label is only announced to screen readers, unless `showLabel` writes it out beside the mark. */
export function ThinkingIndicator({ label, showLabel = false, startedAt }: { label: string; showLabel?: boolean; startedAt?: number }) {
  const elapsed = useElapsed(startedAt);

  return (
    <div role="status" aria-label={label} className="flex w-fit items-center gap-2 px-1 py-1">
      {/* A plain running ring, so the time beside it reads as the turn's (the logo didn't say what it measured). */}
      <SpinnerRing size={12} stroke={1.6} color="var(--ink-4)" />
      {showLabel && (
        <span aria-hidden className="min-w-0 truncate text-12 text-ink-3">
          {label}
        </span>
      )}
      <span aria-hidden className="text-12 tabular-nums text-ink-3">
        {elapsed}
      </span>
    </div>
  );
}

/**
 * The Chat's turn ended, but background work goes on (chat-activity.mjs): how many tasks, and for how long the oldest
 * has run. Their results come back to the Chat by themselves; no turn runs, so there is no running mark.
 */
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
