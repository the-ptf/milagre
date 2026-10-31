import { useSyncExternalStore } from "react";
import type { DictationModelState } from "../electron";

// The speech models on this computer, shared by Settings and every composer: one download shows the same ring in both.
// The main process announces each change to every window; the first reader asks for the full list once.
let states: Readonly<Record<string, DictationModelState>> = {};
let started = false;
const listeners = new Set<() => void>();

function set(state: DictationModelState) {
  states = { ...states, [state.id]: state };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  // A bridge without dictation (a check's stubbed window.milagre) reports no models instead of throwing.
  const dictation = window.milagre?.dictation;
  if (!started && typeof dictation?.onModel === "function") {
    started = true;
    dictation.onModel(set);
    void dictation.status().then(
      (list) => list?.forEach(set),
      () => {},
    );
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every model's state by id; a model not reported yet is missing. */
export function useDictationModels() {
  return useSyncExternalStore(subscribe, () => states);
}

export const dictationModels = {
  download: (id: string) => window.milagre.dictation.download(id),
  cancel: (id: string) => window.milagre.dictation.cancel(id),
  remove: (id: string) => window.milagre.dictation.remove(id),
};
