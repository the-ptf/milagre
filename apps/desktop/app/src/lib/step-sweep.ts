import type { CSSProperties } from "react";
import type { ChatStep } from "../model";
import { SWEEP_MS } from "@milagre/shared/step-sweep";
import { useStepSweep } from "@milagre/shared/use-step-sweep";

export function useStepTitleSweep(step: Pick<ChatStep, "id" | "startedAt">, running: boolean) {
  const remaining = useStepSweep(step.startedAt, running);
  return {
    className: running ? `step-running${remaining ? " step-sweep" : ""}` : undefined,
    style: remaining ? ({ "--sweep-delay": `${remaining - SWEEP_MS}ms` } as CSSProperties) : undefined,
  };
}
