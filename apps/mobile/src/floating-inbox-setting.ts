import { useSyncExternalStore } from "react";
import { readFloatingInbox, saveFloatingInbox, readFloatingInboxActivity, saveFloatingInboxActivity } from "./hosts-native";

let enabled = false;
let changed = false;
const listeners = new Set<() => void>();
void readFloatingInbox().then((saved) => {
  if (changed) return;
  enabled = saved;
  listeners.forEach((listener) => listener());
});

export function useFloatingInbox(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => enabled,
  );
  return [
    on,
    (next) => {
      changed = true;
      enabled = next;
      listeners.forEach((listener) => listener());
      void saveFloatingInbox(next);
    },
  ];
}

let activity = true;
let activityChanged = false;
const activityListeners = new Set<() => void>();
void readFloatingInboxActivity().then((saved) => {
  if (activityChanged) return;
  activity = saved;
  activityListeners.forEach((listener) => listener());
});

export function useFloatingInboxActivity(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (listener) => {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },
    () => activity,
  );
  return [
    on,
    (next) => {
      activityChanged = true;
      activity = next;
      activityListeners.forEach((listener) => listener());
      void saveFloatingInboxActivity(next);
    },
  ];
}
