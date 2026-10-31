import { TurboModuleRegistry } from "react-native";
import { appleLocale, dictationLanguage } from "@milagre/shared/dictation";
import { dictationWav, joinSegments } from "@milagre/shared/voice-dictation";
import type { Transcriber } from "./voice-transcription";
import { serializeTranscription } from "./voice-transcription-queue";
import { getTranscriber as getWhisperTranscriber } from "./voice-transcription-whisper";

type Native = {
  isAvailable(language: string): boolean;
  prepare(language: string): Promise<void>;
  /** `contextualStrings` (Milagre's patch, patches/@react-native-ai+apple): the project's words, one per line. */
  transcribe(data: ArrayBufferLike, language: string, contextualStrings?: string): Promise<{ segments: { text: string }[] }>;
};

// The spec file calls `getEnforcing` on import, which logs a red error in dev before it throws when the build lacks the module
// (Expo Go, a build from before dictation). `get` asks without that, so the spec is only required once the module exists.
function loadNative(): Native | null {
  if (!TurboModuleRegistry.get("NativeAppleTranscription")) return null;
  try {
    const spec = require("@react-native-ai/apple/src/NativeAppleTranscription").default as Native;
    return {
      ...spec,
      // The patched JSI function takes the words as a third argument; the spec's wrapper passes two.
      transcribe: (data, language, contextualStrings = "") =>
        (globalThis as unknown as Record<string, Native["transcribe"]>)["__apple__llm__transcribe__"]!(data, language, contextualStrings),
    };
  } catch {
    return null;
  }
}

export function getTranscriber(): Transcriber | null {
  const native = loadNative();
  const whisper = TurboModuleRegistry.get("RNWhisper") ? getWhisperTranscriber() : null;
  let appleAvailable = false;
  try {
    appleAvailable = native?.isAvailable("") ?? false;
  } catch {
    // Apple dictation needs iOS 26; automatic detection and older devices can use Whisper independently.
  }
  if (!native || !appleAvailable) return whisper;
  const unavailable = () => Promise.reject(new Error("Automatic dictation isn't available in this build. Choose a language or update Milagre."));
  return {
    prepare: (preference, onProgress) => {
      const language = dictationLanguage(preference);
      return language === "auto"
        ? (whisper?.prepare(language, onProgress) ?? unavailable())
        : serializeTranscription(() => native.prepare(appleLocale(language)));
    },
    transcribe: (audio, { language: preference, terms }) => {
      const language = dictationLanguage(preference);
      return language === "auto"
        ? (whisper?.transcribe(audio, { language, terms }) ?? unavailable())
        : serializeTranscription(async () => {
            const result = await native.transcribe(dictationWav(audio), appleLocale(language), terms.join("\n"));
            return joinSegments(result.segments);
          });
    },
  };
}
