const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { WHISPER_MODELS, silentPcm, whisperText } = require("@milagre/shared/dictation");

const IDLE_RELEASE_MS = 3 * 60 * 1000;
const PROGRESS_MS = 100;

/**
 * @typedef {{ id: string, file: string, size: number, sha256?: string, url?: string }} Model
 * @typedef {{ id: string, ready: boolean, size: number, received: number | null }} ModelState
 * @param {{ dataDir: string, models?: readonly Model[], fetch?: typeof globalThis.fetch,
 *   loadWhisper?: () => Promise<{ initWhisper: (options: { filePath: string, useGpu?: boolean }) => Promise<any> }>,
 *   onChange?: (state: ModelState) => void }} options
 */
function createDictation({
  dataDir,
  models = WHISPER_MODELS.desktop,
  fetch = globalThis.fetch,
  loadWhisper = async () => require("@fugood/whisper.node"),
  onChange = () => {},
}) {
  const folder = path.join(dataDir, "dictation");
  const fileOf = (/** @type {Model} */ model) => path.join(folder, model.file);
  /** @type {Map<string, { promise: Promise<void>, controller: AbortController, received: number }>} */
  const downloads = new Map();
  /** @type {{ id: string, whisper: Promise<any> } | null} */
  let context = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idle = null;
  let tail = Promise.resolve();

  function modelOf(id) {
    const model = models.find((item) => item.id === id) ?? (id === undefined ? models[0] : undefined);
    if (!model) throw new Error(`There is no speech model named ${id}.`);
    return model;
  }

  function serial(work) {
    if (idle) clearTimeout(idle);
    idle = null;
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  }

  const ready = (/** @type {Model} */ model) =>
    fsp.stat(fileOf(model)).then(
      (stat) => stat.size === model.size,
      () => false,
    );

  /** @returns {Promise<ModelState>} */
  async function stateOf(model) {
    return { id: model.id, ready: await ready(model), size: model.size, received: downloads.get(model.id)?.received ?? null };
  }

  const announce = (model) => void stateOf(model).then(onChange, () => {});

  function download(id) {
    const model = modelOf(id);
    const running = downloads.get(model.id);
    if (running) return running.promise;
    const controller = new AbortController();
    const entry = { controller, received: 0, promise: Promise.resolve() };
    entry.promise = (async () => {
      if (await ready(model)) return;
      await fsp.mkdir(folder, { recursive: true });
      const partial = `${fileOf(model)}.${randomUUID()}.part`;
      try {
        const response = await fetch(/** @type {string} */ (model.url), { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`The speech model didn't download (HTTP ${response.status}).`);
        const hash = createHash("sha256");
        let reported = 0;
        const body = Readable.fromWeb(/** @type {any} */ (response.body));
        body.on("data", (chunk) => {
          hash.update(chunk);
          entry.received += chunk.length;
          if (Date.now() - reported < PROGRESS_MS) return;
          reported = Date.now();
          onChange({ id: model.id, ready: false, size: model.size, received: entry.received });
        });
        await pipeline(body, fs.createWriteStream(partial), { signal: controller.signal });
        if (hash.digest("hex") !== model.sha256) throw new Error("The speech model download was damaged. Try again.");
        await fsp.rename(partial, fileOf(model));
      } finally {
        await fsp.rm(partial, { force: true });
      }
    })().finally(() => {
      downloads.delete(model.id);
      announce(model);
    });
    downloads.set(model.id, entry);
    onChange({ id: model.id, ready: false, size: model.size, received: 0 });
    return entry.promise;
  }

  function cancel(id) {
    downloads.get(modelOf(id).id)?.controller.abort();
  }

  function release() {
    if (idle) clearTimeout(idle);
    idle = null;
    const current = context;
    context = null;
    return current?.whisper.then((whisper) => whisper.release()).catch(() => {});
  }

  async function warm(model) {
    await download(model.id);
    if (context && context.id !== model.id) await release();
    if (!context) {
      const whisper = loadWhisper().then((native) => native.initWhisper({ filePath: fileOf(model), useGpu: true }));
      const loading = { id: model.id, whisper };
      context = loading;
      whisper.catch(() => {
        if (context === loading) context = null;
      });
    }
    return context.whisper;
  }

  function keepWarm() {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => void serial(release), IDLE_RELEASE_MS);
    idle.unref?.();
  }

  /**
   * @param {{ audio: ArrayBuffer, language?: string, prompt?: string, model?: string }} request
   */
  async function transcribe({ audio, language = "auto", prompt = "", model: id }) {
    if (!(audio instanceof ArrayBuffer) || audio.byteLength < 3200 || silentPcm(new Int16Array(audio, 0, audio.byteLength >> 1))) return { text: "" };
    if (idle) clearTimeout(idle);
    const whisper = await warm(modelOf(id));
    try {
      const { promise } = whisper.transcribeData(audio, {
        language,
        prompt: prompt || undefined,
        temperature: 0,
        maxThreads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
      });
      const { result, segments } = await promise;
      return { text: whisperText(result, segments, prompt) };
    } finally {
      keepWarm();
    }
  }

  async function remove(id) {
    const model = modelOf(id);
    cancel(model.id);
    await downloads.get(model.id)?.promise.catch(() => {});
    await serial(async () => {
      if (context?.id === model.id) await release();
      await fsp.rm(fileOf(model), { force: true });
    });
    announce(model);
  }

  return {
    status: () => Promise.all(models.map(stateOf)),
    download,
    cancel,
    remove,
    prepare: (id) =>
      serial(async () => {
        await warm(modelOf(id));
        keepWarm();
      }),
    transcribe: (request) => serial(() => transcribe(request)),
    release: () => serial(release),
  };
}

module.exports = { createDictation };
