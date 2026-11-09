import type { UsageDisplay } from "../../lib/settings";
import { shownPercent, usageTone } from "./format";

// ProgressBar's fills: ink, then the status tone as a window nears its limit (80% orange, 95% red). The sidebar's
// meters are thinner than ProgressBar's 4px, so this keeps its own markup and takes the height from `className`.
const FILL = { normal: "bg-ink", warning: "bg-orange", critical: "bg-red" } as const;

// The fill tracks the shown percent (it drains in "remaining" mode); the shade always tracks how much is used.
export function UsageBar({
  usedPercent,
  display,
  className,
  tone,
}: {
  usedPercent: number;
  display: UsageDisplay;
  className: string;
  tone?: "normal" | "warning" | "critical" | "stale";
}) {
  const fill = tone ? { normal: "bg-ink-3", warning: "bg-orange", critical: "bg-red", stale: "bg-ink-3" }[tone] : FILL[usageTone(usedPercent)];
  return (
    <span aria-hidden className={`relative block shrink-0 overflow-hidden rounded-full bg-line-strong ${className}`}>
      <span
        className={`absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-slow motion-reduce:transition-none ${fill}`}
        style={{ width: `${shownPercent(usedPercent, display)}%` }}
      />
    </span>
  );
}
