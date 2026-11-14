import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";

// Settings › Plan usage › Show in sidebar, on this phone only. The phone sidebar has no meters, so its choice is the
// desktop's Button or Off: the Plan usage button beside Filters, shown by default.
const key = "milagre.usage-button.v1";
let shown = true;
let changed = false;
const listeners = new Set<() => void>();
void SecureStore.getItemAsync(key)
  .then((saved) => {
    if (changed) return;
    shown = saved !== "off";
    listeners.forEach((listener) => listener());
  })
  .catch(() => {});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function setShown(next: boolean) {
  changed = true;
  shown = next;
  listeners.forEach((listener) => listener());
  void SecureStore.setItemAsync(key, next ? "on" : "off", { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }).catch(() => {
    /* Keep the in-memory preference if storage is unavailable. */
  });
}
/** Whether the Chats list shows the Plan usage button beside Filters on this phone. */
export function useUsageButtonShown(): [boolean, (next: boolean) => void] {
  return [useSyncExternalStore(subscribe, () => shown), setShown];
}
