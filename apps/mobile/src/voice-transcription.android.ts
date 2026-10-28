import { Directory, File, Paths } from "expo-file-system";
import { WHISPER_MODELS, silentPcm, whisperPrompt, whisperText } from "@milagre/shared/dictation";
import type { Transcriber } from "./voice-transcription";

// Whisper on the phone: the model downloads once into the app's documents, and its context stays loaded after the first take.
const MODEL = WHISPER_MODELS.phone;
const folder = new Directory(Paths.document, "whisper");
const model = new File(folder, MODEL.file);

type WhisperContext = {
  transcribe(path: string, options: { language: string; prompt?: string; temperature: number }): { promise: Promise<{ result: string }> };
};
// Required when first used, typed by hand: the package maps no "." export, and its source (what TypeScript reads under
// the react-native condition) doesn't typecheck against this app's React Native.
const initWhisper = (options: { filePath: string }): Promise<WhisperContext> =>
  (require("whisper.rn/index") as { initWhisper: (options: { filePath: string }) => Promise<WhisperContext> }).initWhisper(options);

let download: Promise<void> | null = null;
let context: Promise<WhisperContext> | null = null;

// ponytail: the phone checks the size of the pinned revision, not its hash (expo-file-system here has no file digest);
// desktop checks the SHA-256 (apps/desktop/electron/dictation.cjs).
function prepare(onProgress?: (fraction: number) => void): Promise<void> {
  if (model.exists && model.size === MODEL.size) return Promise.resolve();
  download ??= (async () => {
    if (!folder.exists) folder.create({ intermediates: true });
    const partial = new File(folder, `${MODEL.file}.part`);
    if (partial.exists) partial.delete();
    try {
      await File.downloadFileAsync(MODEL.url, partial, {
        onProgress: ({ bytesWritten }) => onProgress?.(Math.min(1, bytesWritten / MODEL.size)),
      });
      if (partial.size !== MODEL.size) throw new Error("The speech model download was cut off. Try again.");
      if (model.exists) model.delete();
      partial.move(model);
    } finally {
      if (partial.exists) partial.delete();
    }
  })().finally(() => {
    download = null;
  });
  return download;
}

export function getTranscriber(): Transcriber {
  return {
    polish: false,
    prepare: (_language, onProgress) => prepare(onProgress),
    transcribe: async (uri, { language, terms }) => {
      // The WAV's samples after its 44-byte header; a silent take has nothing to transcribe.
      const wav = await new File(uri).arrayBuffer();
      if (silentPcm(new Int16Array(wav, 44, (wav.byteLength - 44) >> 1))) return "";
      await prepare();
      const loading = (context ??= initWhisper({ filePath: model.uri }));
      loading.catch(() => {
        if (context === loading) context = null;
      });
      const whisper = await loading;
      const { promise } = whisper.transcribe(uri, { language, prompt: whisperPrompt(terms) || undefined, temperature: 0 });
      return whisperText((await promise).result);
    },
  };
}
