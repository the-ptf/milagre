import { useSyncExternalStore } from "react";
import { Directory, File, Paths } from "expo-file-system";
import { WHISPER_MODELS, silentPcm, whisperLanguage, whisperModelFor, whisperPrompt, whisperText, type WhisperModel } from "@milagre/shared/dictation";
import type { Transcriber } from "./voice-transcription";
import { serializeTranscription } from "./voice-transcription-queue";

// Whisper on the phone: each model downloads once into the app's documents, picked in Settings or on the first take that
// needs it, and the one in use stays loaded after the first take.
const folder = new Directory(Paths.document, "whisper");
const fileOf = (model: WhisperModel) => new File(folder, model.file);

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
  release(): Promise<void>;
};
// Required when first used, typed by hand: the package maps no "." export, and its source (what TypeScript reads under
// the react-native condition) doesn't typecheck against this app's React Native.
const initWhisper = (options: { filePath: string }): Promise<WhisperContext> =>
  (
    require("whisper.rn/index") as {
      initWhisper: (options: { filePath: string }) => Promise<WhisperContext>;
    }
  ).initWhisper(options);

/** A model on this phone: downloaded, and how many bytes of its download in flight have arrived (null when none is). */
export type WhisperModelState = { ready: boolean; received: number | null };

const downloads = new Map<string, { promise: Promise<void>; controller: AbortController; received: number }>();
let states: Readonly<Record<string, WhisperModelState>> | null = null;
const listeners = new Set<() => void>();
let context: { id: string; whisper: Promise<WhisperContext> } | null = null;

// ponytail: the phone checks the size of the pinned revision, not its hash (expo-file-system here has no file digest);
// desktop checks the SHA-256 (apps/desktop/electron/dictation.cjs).
function readyOf(model: WhisperModel) {
  const file = fileOf(model);
  return file.exists && file.size === model.size;
}

function snapshot() {
  states ??= Object.fromEntries(WHISPER_MODELS.phone.map((model) => [model.id, { ready: readyOf(model), received: null }]));
  return states;
}

function update(model: WhisperModel) {
  states = { ...snapshot(), [model.id]: { ready: readyOf(model), received: downloads.get(model.id)?.received ?? null } };
  for (const listener of listeners) listener();
}

/** Every phone model's state by id, shared by Settings and the composer's mic. */
export function useWhisperModels() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, snapshot);
}

/** Downloads a model once; a second call while it downloads joins the first. Cancelling rejects it with an AbortError. */
export function downloadWhisperModel(id: string): Promise<void> {
  const model = whisperModelFor("phone", id);
  const running = downloads.get(model.id);
  if (running) return running.promise;
  if (readyOf(model)) return Promise.resolve();
  const controller = new AbortController();
  const entry = { controller, received: 0, promise: Promise.resolve() };
  entry.promise = (async () => {
    if (!folder.exists) await folder.create({ intermediates: true });
    const partial = new File(folder, `${model.file}.part`);
    if (partial.exists) await partial.delete();
    let moved = false;
    let reported = 0;
    try {
      await File.downloadFileAsync(model.url, partial, {
        signal: controller.signal,
        onProgress: ({ bytesWritten }) => {
          entry.received = Math.min(bytesWritten, model.size);
          // Progress reaches React at most ten times a second.
          if (Date.now() - reported < 100) return;
          reported = Date.now();
          update(model);
        },
      });
      if (partial.size !== model.size) throw new Error("The speech model download was cut off. Try again.");
      const file = fileOf(model);
      if (file.exists) await file.delete();
      await partial.move(file);
      moved = true;
    } finally {
      // move() is async and changes partial.uri to the destination. Never delete the successfully promoted model.
      if (!moved && partial.exists) await partial.delete();
    }
  })().finally(() => {
    downloads.delete(model.id);
    update(model);
  });
  downloads.set(model.id, entry);
  update(model);
  return entry.promise;
}

export function cancelWhisperModel(id: string) {
  downloads.get(whisperModelFor("phone", id).id)?.controller.abort();
}

function release() {
  const current = context;
  context = null;
  return current?.whisper.then((whisper) => whisper.release()).catch(() => {});
}

/** Deletes a downloaded model, cancelling its download and freeing it from memory first. */
export async function deleteWhisperModel(id: string) {
  const model = whisperModelFor("phone", id);
  cancelWhisperModel(model.id);
  await downloads.get(model.id)?.promise.catch(() => {});
  await serializeTranscription(async () => {
    if (context?.id === model.id) await release();
    const file = fileOf(model);
    if (file.exists) await file.delete();
  });
  update(model);
}

async function warm(model: WhisperModel) {
  await downloadWhisperModel(model.id);
  // One model in memory at a time: switching models frees the last one first.
  if (context && context.id !== model.id) await release();
  if (!context) {
    const loading = { id: model.id, whisper: initWhisper({ filePath: fileOf(model).uri }) };
    context = loading;
    loading.whisper.catch(() => {
      if (context === loading) context = null;
    });
  }
  return context.whisper;
}

export function getTranscriber(): Transcriber {
  return {
    missingModel: (_language, id) => {
      const model = whisperModelFor("phone", id);
      return readyOf(model) ? null : model.id;
    },
    prepare: (_language, id) =>
      serializeTranscription(async () => {
        await warm(whisperModelFor("phone", id));
      }),
    transcribe: (audio, { language, terms, model: id }) =>
      serializeTranscription(async () => {
        if (silentPcm(new Int16Array(audio))) return "";
        const model = whisperModelFor("phone", id);
        const whisper = await warm(model);
        const spoken = whisperLanguage(language, model);
        const { promise } = whisper.transcribeData(audio, {
          language: spoken,
          prompt: whisperPrompt(terms, spoken) || undefined,
          temperature: 0,
          translate: false,
        });
        return whisperText((await promise).result);
      }),
  };
}
