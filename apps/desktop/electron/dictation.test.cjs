const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, mkdir, writeFile, rm, stat } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const { createDictation } = require("./dictation.cjs");

async function fixture(t, native) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "milagre-whisper-test-"));
  const model = { id: "test", file: "test.bin", size: 1 };
  await mkdir(path.join(dataDir, "dictation"));
  await writeFile(path.join(dataDir, "dictation", model.file), "x");
  const dictation = createDictation({ dataDir, models: [model], loadWhisper: async () => native });
  t.after(async () => {
    await dictation.release();
    await rm(dataDir, { recursive: true, force: true });
  });
  return dictation;
}
const audio = () => new Int16Array(16000).fill(4000).buffer;

test("prepare loads the native model before the first transcription and reuses it", async (t) => {
  let loads = 0;
  const d = await fixture(t, {
    initWhisper: async () => {
      loads++;
      return { transcribeData: () => ({ promise: Promise.resolve({ result: "speech" }) }), release: async () => {} };
    },
  });
  await d.prepare();
  assert.equal(loads, 1);
  assert.deepEqual(await d.transcribe({ audio: audio() }), { text: "speech" });
  await d.prepare();
  assert.equal(loads, 1);
});

test("different windows cannot run native Whisper inference concurrently", async (t) => {
  let resolve;
  const first = new Promise((done) => {
    resolve = done;
  });
  let calls = 0;
  let entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const d = await fixture(t, {
    initWhisper: async () => ({
      transcribeData: () => {
        entered();
        return { promise: ++calls === 1 ? first : Promise.resolve({ result: "second" }) };
      },
      release: async () => {},
    }),
  });
  const a = d.transcribe({ audio: audio() });
  const b = d.transcribe({ audio: audio() });
  await started;
  assert.equal(calls, 1);
  resolve({ result: "first" });
  assert.deepEqual(await a, { text: "first" });
  assert.deepEqual(await b, { text: "second" });
});

test("a failed model initialization can be retried; silence does not initialize it", async (t) => {
  let loads = 0;
  const d = await fixture(t, {
    initWhisper: async () => {
      if (++loads === 1) throw new Error("model unavailable");
      return { transcribeData: () => ({ promise: Promise.resolve({ result: "retry" }) }), release: async () => {} };
    },
  });
  assert.deepEqual(await d.transcribe({ audio: new ArrayBuffer(32000) }), { text: "" });
  assert.equal(loads, 0);
  await assert.rejects(d.prepare(), /model unavailable/);
  await d.prepare();
  assert.equal(loads, 2);
});

const BYTES = Buffer.alloc(4096, 7);
const remote = {
  id: "remote",
  file: "remote.bin",
  size: BYTES.length,
  sha256: createHash("sha256").update(BYTES).digest("hex"),
  url: "https://example.test/remote.bin",
};

/** A response that streams the model in 1 KiB chunks, waiting on `gate` before the last one. */
function streamed(gate = Promise.resolve()) {
  return async (_url, { signal }) => {
    const body = new ReadableStream({
      async start(controller) {
        for (let offset = 0; offset < BYTES.length; offset += 1024) {
          if (offset + 1024 >= BYTES.length) await gate;
          if (signal.aborted) return controller.error(signal.reason);
          controller.enqueue(BYTES.subarray(offset, offset + 1024));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };
}

async function downloads(t, fetch) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "milagre-whisper-test-"));
  const changes = [];
  const dictation = createDictation({ dataDir, models: [remote], fetch, onChange: (state) => changes.push(state), loadWhisper: async () => ({}) });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dictation, changes, file: path.join(dataDir, "dictation", remote.file) };
}

test("a model downloads once, checked by hash, and status says it is ready", async (t) => {
  const { dictation, changes, file } = await downloads(t, streamed());
  assert.deepEqual(await dictation.status(), [{ id: "remote", ready: false, size: BYTES.length, received: null }]);
  await Promise.all([dictation.download("remote"), dictation.download("remote")]);
  assert.equal((await stat(file)).size, BYTES.length);
  // The last report follows the download after a file check of its own; a busy runner takes longer than one turn.
  for (let wait = 0; wait < 100 && !changes.at(-1)?.ready; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(changes.at(-1), { id: "remote", ready: true, size: BYTES.length, received: null });
  assert.deepEqual(await dictation.status(), [{ id: "remote", ready: true, size: BYTES.length, received: null }]);
});

test("a cancelled download leaves no file behind, and a downloaded model can be deleted", async (t) => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const { dictation, file } = await downloads(t, streamed(gate));
  const running = dictation.download("remote");
  await new Promise((resolve) => setTimeout(resolve, 10));
  dictation.cancel("remote");
  open();
  await assert.rejects(running, (error) => error.name === "AbortError");
  await assert.rejects(stat(file));
  const { dictation: again, file: second } = await downloads(t, streamed());
  await again.download("remote");
  await again.remove("remote");
  await assert.rejects(stat(second));
  assert.equal((await again.status())[0].ready, false);
});

test("an unknown model id is refused", async (t) => {
  const { dictation } = await downloads(t, streamed());
  assert.throws(() => dictation.download("nope"), /no speech model/);
});
