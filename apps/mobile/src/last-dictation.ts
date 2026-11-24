import { File, Paths } from "expo-file-system";
import { lastDictationStore } from "@milagre/shared/dictation";

const file = () => new File(Paths.cache, "last-dictation.txt");
export const { get: lastDictation, save: saveLastDictation } = lastDictationStore(
  () => (file().exists ? file().textSync() : null),
  (text) => file().writeSync(text),
);
