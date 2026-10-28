import type { DictationPhase } from "@milagre/shared/voice-dictation";

/**
 * Whether the floating controls stay on screen whatever the list does. A dictation under way (the mic is the only way to stop
 * it) and the focused search field both hold them; once neither does, scrolling hides them again.
 */
export const pinsControls = (phase: DictationPhase, focused: boolean) => focused || phase !== "idle";

/** How far the controls are hidden, 0..1: the list's wish, unless they are pinned. */
export function shownHidden(hidden: number, pinned: number) {
  "worklet"; // called from animated styles, on the UI thread
  return hidden * (1 - pinned);
}
