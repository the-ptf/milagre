import { useEffect, useState, type ReactNode } from "react";
import { backgroundLabel } from "@milagre/shared/chat-activity";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";

/** The Milagre mark running: the legs take turns striding while the sparkle bobs and turns a quarter on each step. */
function RunningLogo() {
  return (
    <svg aria-hidden viewBox="-4 -4 154 154" width="16" height="16" fill="none" className="running-logo shrink-0">
      <g className="running-logo-mark">
        <path
          className="running-logo-leg running-logo-leg-left"
          d="M49.6983 66.5562L21.6836 116.174C19.802 119.507 22.2098 123.632 26.0372 123.632H39.9727L54.9727 100.132L66.9727 119.632L51.9727 144.132H26.0372C6.24066 144.132 -6.29344 122.89 3.27837 105.561L30.9405 55.4819L49.6983 66.5562Z"
        />
        <path
          className="running-logo-leg running-logo-leg-right"
          d="M142.666 105.561C152.238 122.89 139.704 144.132 119.907 144.132H93.9728L78.9728 119.632L90.9728 100.132L105.973 123.632H119.907C123.735 123.632 126.143 119.507 124.261 116.174L96.2462 66.5562L115.004 55.4819L142.666 105.561Z"
        />
        <path
          className="running-logo-star"
          d="M69.528 1.96636C71.0759 -0.655453 74.869 -0.655453 76.4169 1.96636L91.0103 26.6837C91.3538 27.2656 91.8392 27.751 92.4211 28.0945L117.138 42.6879C119.76 44.2358 119.76 48.0289 117.138 49.5768L92.4211 64.1702C91.8392 64.5137 91.3538 64.9991 91.0103 65.581L76.4169 90.2983C74.869 92.9201 71.0759 92.9201 69.528 90.2983L54.9347 65.581C54.5911 64.9991 54.1057 64.5137 53.5238 64.1702L28.8065 49.5768C26.1847 48.0289 26.1847 44.2358 28.8065 42.6879L53.5238 28.0945C54.1057 27.751 54.5911 27.2656 54.9347 26.6837L69.528 1.96636Z"
        />
      </g>
    </svg>
  );
}

function useElapsed(startedAt?: number) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  const total = Math.floor(Math.max(0, now - (startedAt ?? mountedAt)) / 100) / 10;
  return total < 60 ? `${total.toFixed(1)}s` : `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/** The running mark and the elapsed time. The label is only announced to screen readers, unless `showLabel` writes it out beside the mark. */
export function ThinkingIndicator({ label, showLabel = false, startedAt }: { label: string; showLabel?: boolean; startedAt?: number }) {
  const elapsed = useElapsed(startedAt);

  return (
    <div role="status" aria-label={label} className="flex w-fit items-center gap-2.5 px-1 py-1">
      <RunningLogo />
      {showLabel && (
        <span aria-hidden className="min-w-0 truncate text-[12px] text-ink-3">
          {label}
        </span>
      )}
      <span aria-hidden className="font-mono text-[12px] tabular-nums text-ink-3">
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
      className="flex w-fit max-w-full items-center gap-2 rounded-[8px] px-1 py-1 text-left text-[12px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
    >
      {mark}
      <span aria-hidden className="min-w-0 truncate">
        {label}
      </span>
      <span aria-hidden className="font-mono tabular-nums">
        {elapsed}
      </span>
      <HugeiconsIcon aria-hidden icon={ArrowDown01Icon} size={12} className={`shrink-0 text-ink-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
    </button>
  );
}
