import { useState } from "react";
import { useWindowDimensions } from "react-native";
import type { FlowRun, ModelProvider, RoutineRun } from "@milagre/shared/model";
import { currentStep, failedStep, flowProblems, runRows, stepSubtitle } from "@milagre/shared/routine-flows";
import { triggerChipText } from "@milagre/shared/routines";
import type { RoutineWithRuns } from "./use-routines";
import type { FlowDraft } from "./flow-draft";
import { FlowSteps, openAdd, openStep } from "./flow-editor";
import { FlowCanvas, type CanvasMark } from "./flow-canvas";
import { stepRunLine, triggerRunLine, triggerTitle } from "./flow-looks";

const deviceZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

export function FlowStepsTab({
  routine,
  routines,
  draft,
  modelName,
  reserved,
  onTrigger,
  onInteract,
}: {
  routine: RoutineWithRuns;
  routines: RoutineWithRuns[];
  draft: FlowDraft;
  modelName: (provider: ModelProvider | undefined, model: string) => string;
  reserved: number;
  onTrigger: () => void;
  onInteract: (active: boolean) => void;
}) {
  const { height } = useWindowDimensions();
  if (draft.steps.length === 0) return <FlowSteps routine={routine} routines={routines} draft={draft} modelName={modelName} onTrigger={onTrigger} />;
  const problems = new Map(flowProblems(draft.steps, routine.trigger.kind).flatMap((item) => (item.stepId ? [[item.stepId, item.message] as const] : [])));
  return (
    <FlowCanvas
      steps={draft.steps}
      trigger={{ title: triggerTitle(routine.trigger), subtitle: triggerChipText(routine.trigger, deviceZone()) }}
      subtitle={(step) => stepSubtitle(step, { modelName })}
      height={Math.max(380, height - reserved)}
      problems={problems}
      onPress={(id) => (id === "trigger" ? onTrigger() : openStep(routine.id, id))}
      onAdd={(where) => openAdd(routine.id, where)}
      onInteract={onInteract}
    />
  );
}

/** The step a Run's canvas shows below it: the one picked, else the one waiting, failed or last done. */
export function useRunCanvas(run: RoutineRun | undefined, now: number) {
  const flow: FlowRun | undefined = run?.flow;
  const [picked, setPicked] = useState<string | null>(null);
  const rows = runRows(flow);
  const stepRows = new Map(rows.flatMap((row) => (row.kind === "step" ? [[row.step.id, row] as const] : [])));
  const lastDone = rows.findLast((row) => row.kind === "step" && row.status === "done");
  const fallback = currentStep(flow)?.id ?? (flow ? failedStep(flow)?.id : undefined) ?? (lastDone?.kind === "step" ? lastDone.step.id : "trigger");
  const shown = picked ?? fallback;
  const mark = (id: string): CanvasMark | undefined => {
    if (!run) return undefined;
    if (id === "trigger") return { status: "done", text: triggerRunLine(run), run: null };
    const row = stepRows.get(id);
    return row ? { status: row.status, text: stepRunLine(row, now), run: row.run } : undefined;
  };
  return { shown, shownRow: stepRows.get(shown), mark, pick: setPicked };
}
