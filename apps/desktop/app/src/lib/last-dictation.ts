import { lastDictationStore } from "@milagre/shared/dictation";

export const { get: lastDictation, save: saveLastDictation } = lastDictationStore(
  () => localStorage.getItem("milagre.last-dictation"),
  (text) => localStorage.setItem("milagre.last-dictation", text),
);
