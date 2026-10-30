import type { UsageDisplay } from "../../lib/settings";
import { shownPercent, usageTone } from "./format";

// Neutral grays only: the fill darkens as a window nears its limit.
const FILL = { normal: "bg-ink-3", warning: "bg-ink-2", critical: "bg-ink" } as const;

// The fill tracks the shown percent (it drains in "remaining" mode); the shade always tracks how much is used.
export function UsageBar({ usedPercent, display, className }: { usedPercent: number; display: UsageDisplay; className: string }) {
  return (
    <span aria-hidden className={`relative block shrink-0 overflow-hidden rounded-full bg-line-strong ${className}`}>
      <span
        className={`absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-slow ease-enter motion-reduce:transition-none ${FILL[usageTone(usedPercent)]}`}
        style={{ width: `${shownPercent(usedPercent, display)}%` }}
      />
    </span>
  );
}
