import { useSyncExternalStore } from "react";
import { readPanelWidth, savePanelWidth } from "./hosts-native";
import { CHANGES_WIDTH } from "./split-width";

// The width the iPad's docked right panel was dragged to, read once and kept on this device. Each window clamps it to the
// room it has (clampPanelWidth), so a width dragged in landscape still fits in portrait.
let width = CHANGES_WIDTH;
let changed = false;
const listeners = new Set<() => void>();
void readPanelWidth().then((saved) => {
  if (changed || saved === null) return;
  width = saved;
  listeners.forEach((listener) => listener());
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePanelWidth() {
  return useSyncExternalStore(subscribe, () => width);
}

export function setPanelWidth(next: number) {
  changed = true;
  if (next === width) return;
  width = next;
  listeners.forEach((listener) => listener());
  void savePanelWidth(next);
}
