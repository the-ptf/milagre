import { useSyncExternalStore } from "react";
import { createDisplayClock } from "@milagre/shared/display-clock";

const clocks = new Map<number, ReturnType<typeof createDisplayClock>>();
const NO_CLOCK = () => () => {};

export function useDisplayNow(intervalMs: number, enabled = true) {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = createDisplayClock({
      intervalMs,
      isVisible: () => document.visibilityState === "visible",
      onVisibility(listener) {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    });
    clocks.set(intervalMs, clock);
  }
  return useSyncExternalStore(enabled ? clock.subscribe : NO_CLOCK, clock.snapshot);
}

/** Each renderer owns its visibility, including floating inbox windows. No focus check: visible unfocused UI stays live. */
export function followDisplayVisibility() {
  const update = () => document.documentElement.toggleAttribute("data-display-hidden", document.visibilityState !== "visible");
  update();
  document.addEventListener("visibilitychange", update);
  return () => document.removeEventListener("visibilitychange", update);
}
