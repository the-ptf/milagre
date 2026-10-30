import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { mergedRoutineRunText, routineRunText } from "@milagre/shared/routines";
import type { RoutineRunContext } from "@milagre/shared/model";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

/** A heartbeat in the transcript: a hairline with "Heartbeat · 10:15" on it, or the quiet checks folded into one line. */
export function RoutineRunDivider({ context, merged }: { context: RoutineRunContext; merged?: { count: number; last: RoutineRunContext } }) {
  const text = merged ? mergedRoutineRunText(merged) : routineRunText(context);
  return <TranscriptDivider data-routine-run-divider icon={Pulse01Icon} label={text} />;
}
