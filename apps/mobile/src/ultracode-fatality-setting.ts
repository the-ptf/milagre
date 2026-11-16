import { useSyncExternalStore } from "react";
import { readUltracodeFatality, saveUltracodeFatality } from "./hosts-native";

let on = false;
const listeners = new Set<() => void>();
void readUltracodeFatality().then((saved) => {
  on = saved;
  listeners.forEach((listener) => listener());
});

export function useUltracodeFatality(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => on,
  );
  return [
    value,
    (next) => {
      on = next;
      listeners.forEach((listener) => listener());
      void saveUltracodeFatality(next);
    },
  ];
}
