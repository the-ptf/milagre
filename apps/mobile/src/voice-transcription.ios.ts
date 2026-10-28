import { File } from "expo-file-system";
import { TurboModuleRegistry } from "react-native";
import { appleLocale } from "@milagre/shared/dictation";
import { joinSegments } from "@milagre/shared/voice-dictation";
import type { Transcriber } from "./voice-transcription";

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
  if (!native) return null;
  try {
    if (!native.isAvailable("")) return null;
  } catch {
    return null;
  }
  // "" is the phone's own language, which the native side reads (patched to resolve a supported locale each time).
  return {
    polish: true,
    prepare: (language) => native.prepare(appleLocale(language)),
    transcribe: async (uri, { language, terms }) => {
      const audio = await new File(uri).arrayBuffer();
      const result = await native.transcribe(audio, appleLocale(language), terms.join("\n"));
      return joinSegments(result.segments);
    },
  };
}
