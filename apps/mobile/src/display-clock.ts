import { useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "expo-router";
import { createDisplayClock } from "@milagre/shared/display-clock";

const subscribeActive = (listener: () => void) => {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
};
const isActive = () => AppState.currentState === "active";
const clocks = new Map<number, ReturnType<typeof createDisplayClock>>();
const NO_CLOCK = () => () => {};

/** A screen can remain focused while the phone app is backgrounded. Neither state should animate or tick. */
export function useScreenActive() {
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribeActive, isActive, isActive);
  return focused && active;
}

function clockFor(intervalMs: number) {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = createDisplayClock({ intervalMs, isVisible: isActive, onVisibility: subscribeActive });
    clocks.set(intervalMs, clock);
  }
  return clock;
}

export function useDisplayNow(intervalMs: number, enabled = true) {
  const active = useScreenActive();
  const clock = clockFor(intervalMs);
  // An inactive reader may mount long after the shared clock last had a subscriber.
  const [mountedAt] = useState(() => Date.now());
  const now = useSyncExternalStore(active && enabled ? clock.subscribe : NO_CLOCK, clock.snapshot, clock.snapshot);
  return Math.max(now, mountedAt);
}

/** Subscribe to the label so unchanged clock ticks do not render a frame. */
export function useDisplayValue<T extends string | number>(intervalMs: number, compute: (now: number) => T, enabled = true) {
  const active = useScreenActive();
  const clock = clockFor(intervalMs);
  const snapshot = () => compute(clock.snapshot());
  return useSyncExternalStore(active && enabled ? clock.subscribe : NO_CLOCK, snapshot, snapshot);
}
