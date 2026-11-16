import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { normalizeSnoozeMinutes, SNOOZE_DEFAULTS } from "@milagre/shared/snooze";

const key = "milagre.snooze-minutes.v1";
let minutes: number = SNOOZE_DEFAULTS.minutes;
let changed = false;
const listeners = new Set<() => void>();
async function load() {
  const saved = await SecureStore.getItemAsync(key).catch(() => null);
  if (changed || saved === null) return;
  minutes = normalizeSnoozeMinutes(Number(saved));
  listeners.forEach((listener) => listener());
}
void load();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function setMinutes(next: number) {
  changed = true;
  minutes = normalizeSnoozeMinutes(next);
  listeners.forEach((listener) => listener());
  void SecureStore.setItemAsync(key, String(minutes), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }).catch(() => {});
}
export function useSnoozeMinutes(): [number, (next: number) => void] {
  return [useSyncExternalStore(subscribe, () => minutes), setMinutes];
}
