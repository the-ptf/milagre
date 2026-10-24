import { File } from "expo-file-system";
import { TurboModuleRegistry } from "react-native";
import { joinSegments } from "./voice-dictation";
import type { Transcriber } from "./voice-transcription";

type Native = {
  isAvailable(language: string): boolean;
  prepare(language: string): Promise<void>;
  transcribe(data: ArrayBufferLike, language: string): Promise<{ segments: { text: string }[] }>;
};

// The spec file calls `getEnforcing` on import, which logs a red error in dev before it throws when the build lacks the module
// (Expo Go, a build from before dictation). `get` asks without that, so the spec is only required once the module exists.
function loadNative(): Native | null {
  if (!TurboModuleRegistry.get("NativeAppleTranscription")) return null;
  try {
    return require("@react-native-ai/apple/src/NativeAppleTranscription").default as Native;
  } catch {
    return null;
  }
}

export function getTranscriber(): Transcriber | null {
  const native = loadNative();
  if (!native) return null;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    if (!native.isAvailable(locale)) return null;
  } catch {
    return null;
  }
  // `prepare` resolves nothing; the locale asked for is the one the audio is transcribed in.
  return {
    locale,
    prepare: () => native.prepare(locale),
    transcribe: async (uri) => {
      const audio = await new File(uri).arrayBuffer();
      const result = await native.transcribe(audio, locale);
      return joinSegments(result.segments);
    },
  };
}
