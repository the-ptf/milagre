import type { DictationPhase } from "@milagre/shared/voice-dictation";

export const pinsControls = (phase: DictationPhase, focused: boolean) => focused || phase !== "idle";

export function shownHidden(hidden: number, pinned: number) {
  "worklet";
  return hidden * (1 - pinned);
}
