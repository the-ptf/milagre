import { useSyncExternalStore } from "react";
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

export function useDisplayNow(intervalMs: number) {
  const active = useScreenActive();
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = createDisplayClock({ intervalMs, isVisible: isActive, onVisibility: subscribeActive });
    clocks.set(intervalMs, clock);
  }
  return useSyncExternalStore(active ? clock.subscribe : NO_CLOCK, clock.snapshot, clock.snapshot);
}
