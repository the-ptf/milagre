const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createDictation } = require("./dictation.cjs");

async function fixture(t, native) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "milagre-whisper-test-"));
  const model = { file: "test.bin", size: 1 };
  await mkdir(path.join(dataDir, "dictation"));
  await writeFile(path.join(dataDir, "dictation", model.file), "x");
  const dictation = createDictation({ dataDir, model, loadWhisper: async () => native });
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
