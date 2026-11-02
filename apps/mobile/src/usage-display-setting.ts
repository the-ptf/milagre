import { useSyncExternalStore } from "react";
import type { UsageDisplay } from "@milagre/shared/usage";
import { readUsageDisplay, saveUsageDisplay } from "./hosts-native";

let display: UsageDisplay = "used";
let changed = false;
const listeners = new Set<() => void>();
void readUsageDisplay().then((saved) => {
  if (changed) return;
  display = saved;
  listeners.forEach((listener) => listener());
});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function setDisplay(next: UsageDisplay) {
  changed = true;
  display = next;
  listeners.forEach((listener) => listener());
  void saveUsageDisplay(next);
}
/** Device-local display preference; the computer's account assignments are independent. */
export function useUsageDisplay(): [UsageDisplay, (next: UsageDisplay) => void] {
  return [useSyncExternalStore(subscribe, () => display), setDisplay];
}
