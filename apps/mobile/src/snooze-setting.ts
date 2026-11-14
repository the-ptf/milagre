import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { normalizeSnoozeMinutes, SNOOZE_DEFAULTS } from "@milagre/shared/snooze";

// Settings › Chat › Snooze for: how long a row's "Snooze for" snoozes a Chat. Kept on this phone, like desktop keeps its
// own; the computer only stores each Chat's wake time.

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
  void SecureStore.setItemAsync(key, String(minutes), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }).catch(() => {
    /* Keep the in-memory choice if storage is unavailable. */
  });
}
/** The default snooze in minutes, and how to change it. */
export function useSnoozeMinutes(): [number, (next: number) => void] {
  return [useSyncExternalStore(subscribe, () => minutes), setMinutes];
}
