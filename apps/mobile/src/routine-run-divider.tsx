import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { mergedRoutineRunText, routineRunText } from "@milagre/shared/routines";
import type { RoutineRunContext } from "@milagre/shared/model";
import { TranscriptDivider } from "./ui";

export function RoutineRunDivider({ context, merged }: { context: RoutineRunContext; merged?: { count: number; last: RoutineRunContext } }) {
  return <TranscriptDivider label={merged ? mergedRoutineRunText(merged) : routineRunText(context)} icon={Pulse01Icon} />;
}
