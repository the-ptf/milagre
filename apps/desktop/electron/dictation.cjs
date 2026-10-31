const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { WHISPER_MODELS, silentPcm, whisperText } = require("@milagre/shared/dictation");

// Dictation on this computer: whisper.cpp transcribes the window's recording here, so the voice never leaves it. The model
// downloads once, on the first dictation, and stays loaded for a few minutes after the last one.
const IDLE_RELEASE_MS = 3 * 60 * 1000;

/**
 * @param {{ dataDir: string, model?: import("@milagre/shared/dictation").WhisperModel, fetch?: typeof globalThis.fetch,
 *   loadWhisper?: () => Promise<{ initWhisper: (options: { filePath: string, useGpu?: boolean }) => Promise<any> }> }} options
 */
function createDictation({ dataDir, model = WHISPER_MODELS.desktop, fetch = globalThis.fetch, loadWhisper = async () => require("@fugood/whisper.node") }) {
  const file = path.join(dataDir, "dictation", model.file);
  /** @type {Promise<void> | null} */
  let download = null;
  /** @type {Promise<any> | null} */
  let context = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idle = null;
  let tail = Promise.resolve();

  // Several windows can dictate, or a take can be cancelled while its inference is still finishing.
  function serial(work) {
    if (idle) clearTimeout(idle);
    idle = null;
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  }

  const ready = () =>
    fsp.stat(file).then(
      (stat) => stat.size === model.size,
      () => false,
    );

  /** Downloads the model once, checked against its hash; `onProgress` gets the bytes so far of the download in flight. */
  function prepare(onProgress = (_received, _total) => {}) {
    download ??= (async () => {
      if (await ready()) return;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const partial = `${file}.${randomUUID()}.part`;
      try {
        const response = await fetch(model.url);
        if (!response.ok || !response.body) throw new Error(`The speech model didn't download (HTTP ${response.status}).`);
        const hash = createHash("sha256");
        let received = 0;
        const body = Readable.fromWeb(/** @type {any} */ (response.body));
        body.on("data", (chunk) => {
          hash.update(chunk);
          received += chunk.length;
          onProgress(received, model.size);
        });
        await pipeline(body, fs.createWriteStream(partial));
        if (hash.digest("hex") !== model.sha256) throw new Error("The speech model download was damaged. Try again.");
        await fsp.rename(partial, file);
      } finally {
        await fsp.rm(partial, { force: true });
      }
    })().finally(() => {
      download = null;
    });
    return download;
  }

  function release() {
    if (idle) clearTimeout(idle);
    idle = null;
    const current = context;
    context = null;
    return current?.then((whisper) => whisper.release()).catch(() => {});
  }

  async function warm(onProgress = (_received, _total) => {}) {
    await prepare(onProgress);
    context ??= loadWhisper().then((whisper) => whisper.initWhisper({ filePath: file, useGpu: true }));
    const loading = context;
    loading.catch(() => {
      if (context === loading) context = null;
    });
    return loading;
  }

  function keepWarm() {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => void serial(release), IDLE_RELEASE_MS);
    idle.unref?.();
  }

  /**
   * The text of a recording: 16 kHz mono 16-bit PCM. `language` is a Whisper code or "auto"; `prompt` the project's words.
   * @param {{ audio: ArrayBuffer, language?: string, prompt?: string }} request
   */
  async function transcribe({ audio, language = "auto", prompt = "" }, onProgress = (_received, _total) => {}) {
    if (!(audio instanceof ArrayBuffer) || audio.byteLength < 3200 || silentPcm(new Int16Array(audio, 0, audio.byteLength >> 1))) return { text: "" };
    if (idle) clearTimeout(idle);
    const whisper = await warm(onProgress);
    try {
      const { promise } = whisper.transcribeData(audio, {
        language,
        prompt: prompt || undefined,
        temperature: 0,
        maxThreads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
      });
      const { result } = await promise;
      return { text: whisperText(result) };
    } finally {
      keepWarm();
    }
  }

  return {
    prepare: (onProgress) =>
      serial(async () => {
        await warm(onProgress);
        keepWarm();
      }),
    transcribe: (request, onProgress) => serial(() => transcribe(request, onProgress)),
    release: () => serial(release),
    ready,
    size: model.size,
  };
}

module.exports = { createDictation };
