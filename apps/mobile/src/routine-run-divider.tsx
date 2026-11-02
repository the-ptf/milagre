import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { mergedRoutineRunText, routineRunText } from "@milagre/shared/routines";
import type { RoutineRunContext } from "@milagre/shared/model";
import { TranscriptDivider } from "./ui";

/** A heartbeat in the transcript, as on desktop: "Heartbeat · 10:15", or the quiet checks folded into one line. */
export function RoutineRunDivider({ context, merged }: { context: RoutineRunContext; merged?: { count: number; last: RoutineRunContext } }) {
  return <TranscriptDivider label={merged ? mergedRoutineRunText(merged) : routineRunText(context)} icon={Pulse01Icon} />;
}
