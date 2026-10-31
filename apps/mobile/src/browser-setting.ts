import { useSyncExternalStore } from "react";
import { readInternalBrowser, saveInternalBrowser } from "./hosts-native";

let enabled = true;
let revision = 0;
let writes = Promise.resolve();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
void readInternalBrowser().then((saved) => {
  if (revision) return;
  enabled = saved;
  notify();
});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** This device's preference; opening the Browser explicitly still works when links open externally. */
export function useInternalBrowser(): [boolean, (next: boolean) => Promise<void>] {
  return [
    useSyncExternalStore(subscribe, () => enabled),
    async (on) => {
      const previous = enabled;
      const change = ++revision;
      enabled = on;
      notify();
      const write = writes.catch(() => {}).then(() => saveInternalBrowser(on));
      writes = write;
      try {
        await write;
      } catch (error) {
        if (revision === change) {
          enabled = previous;
          notify();
        }
        throw error;
      }
    },
  ];
}
