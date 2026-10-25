import { useMemo, useSyncExternalStore } from "react";
import { createStepSweepWindow } from "./step-sweep";

/** Remaining introductory motion, fixed for this attachment and cleared once at the host deadline. */
export function useStepSweep(startedAt: number | undefined, enabled: boolean): number {
  const window = useMemo(() => createStepSweepWindow(startedAt, enabled), [startedAt, enabled]);
  return useSyncExternalStore(window.subscribe, window.getSnapshot, window.getSnapshot);
}
