import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { mergedRoutineRunText, routineRunText } from "@milagre/shared/routines";
import type { RoutineRunContext } from "@milagre/shared/model";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

export function RoutineRunDivider({ context, merged }: { context: RoutineRunContext; merged?: { count: number; last: RoutineRunContext } }) {
  const text = merged ? mergedRoutineRunText(merged) : routineRunText(context);
  return <TranscriptDivider data-routine-run-divider icon={Pulse01Icon} label={text} />;
}
