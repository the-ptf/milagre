import { HugeiconsIcon } from "@hugeicons/react";
import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { mergedRoutineRunText, routineRunText } from "@milagre/shared/routines";
import type { RoutineRunContext } from "@milagre/shared/model";

/** A heartbeat in the transcript: a hairline with "Heartbeat · 10:15" on it, or the quiet checks folded into one line. */
export function RoutineRunDivider({ context, merged }: { context: RoutineRunContext; merged?: { count: number; last: RoutineRunContext } }) {
  const text = merged ? mergedRoutineRunText(merged) : routineRunText(context);
  return (
    <div data-routine-run-divider className="flex w-full items-center gap-3 py-1 text-[12px] text-ink-3" role="group" aria-label={text}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex min-w-0 items-center gap-1.5 px-2 py-0.5">
        <HugeiconsIcon icon={Pulse01Icon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0" />
        <span className="min-w-0 truncate">{text}</span>
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
