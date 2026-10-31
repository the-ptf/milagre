import { Directory, File, Paths } from "expo-file-system";
import { WHISPER_MODELS, silentPcm, whisperLanguage, whisperPrompt, whisperText } from "@milagre/shared/dictation";
import type { Transcriber } from "./voice-transcription";
import { serializeTranscription } from "./voice-transcription-queue";

// Whisper on the phone: the model downloads once into the app's documents, and its context stays loaded after the first take.
const MODEL = WHISPER_MODELS.phone;
const folder = new Directory(Paths.document, "whisper");
const model = new File(folder, MODEL.file);

type WhisperContext = {
  transcribeData(
    audio: ArrayBuffer,
    options: {
      language: string;
      prompt?: string;
      temperature: number;
      translate: boolean;
    },
  ): {
    promise: Promise<{ result: string }>;
  };
};
// Required when first used, typed by hand: the package maps no "." export, and its source (what TypeScript reads under
// the react-native condition) doesn't typecheck against this app's React Native.
const initWhisper = (options: { filePath: string }): Promise<WhisperContext> =>
  (
    require("whisper.rn/index") as {
      initWhisper: (options: { filePath: string }) => Promise<WhisperContext>;
    }
  ).initWhisper(options);

let download: Promise<void> | null = null;
let context: Promise<WhisperContext> | null = null;

// ponytail: the phone checks the size of the pinned revision, not its hash (expo-file-system here has no file digest);
// desktop checks the SHA-256 (apps/desktop/electron/dictation.cjs).
function prepare(onProgress?: (fraction: number) => void): Promise<void> {
  if (model.exists && model.size === MODEL.size) return Promise.resolve();
  download ??= (async () => {
    if (!folder.exists) await folder.create({ intermediates: true });
    const partial = new File(folder, `${MODEL.file}.part`);
    if (partial.exists) await partial.delete();
    let moved = false;
    try {
      await File.downloadFileAsync(MODEL.url, partial, {
        onProgress: ({ bytesWritten }) => onProgress?.(Math.min(1, bytesWritten / MODEL.size)),
      });
      if (partial.size !== MODEL.size) throw new Error("The speech model download was cut off. Try again.");
      if (model.exists) await model.delete();
      await partial.move(model);
      moved = true;
    } finally {
      // move() is async and changes partial.uri to the destination. Never delete the successfully promoted model.
      if (!moved && partial.exists) await partial.delete();
    }
  })().finally(() => {
    download = null;
  });
  return download;
}

export function getTranscriber(): Transcriber {
  const warm = async (onProgress?: (fraction: number) => void) => {
    await prepare(onProgress);
    const loading = (context ??= initWhisper({ filePath: model.uri }));
    loading.catch(() => {
      if (context === loading) context = null;
    });
    return loading;
  };
  return {
    prepare: (_language, onProgress) =>
      serializeTranscription(async () => {
        await warm(onProgress);
      }),
    transcribe: (audio, { language, terms }) =>
      serializeTranscription(async () => {
        if (silentPcm(new Int16Array(audio))) return "";
        const whisper = await warm();
        const { promise } = whisper.transcribeData(audio, {
          language: whisperLanguage(language),
          prompt: whisperPrompt(terms, language) || undefined,
          temperature: 0,
          translate: false,
        });
        return whisperText((await promise).result);
      }),
  };
}
