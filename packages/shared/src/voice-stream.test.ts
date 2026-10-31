import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingDictation, createDictationResampler, dictationWav } from "./voice-stream.ts";

const speech = (seconds: number, value = 4000) => new Int16Array(Math.round(16000 * seconds)).fill(value);
const silence = (seconds: number) => speech(seconds, 0);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("speech is visible before Stop; a pause and Stop reuse the completed inference", async () => {
  const calls: number[] = [];
  const partials: string[] = [];
  const stream = createStreamingDictation({
    transcribe: async (pcm) => {
      calls.push(pcm.byteLength);
      return "Corrija o Milagre.";
    },
    onPartial: (text) => partials.push(text),
  });
  stream.append(speech(1));
  await stream.idle();
  assert.deepEqual(partials, ["Corrija o Milagre."]);
  stream.append(silence(1));
  assert.equal(await stream.finish(), "Corrija o Milagre.");
  assert.equal(calls.length, 1, "no second recognition or AI call after Stop");
});

test("slow inference coalesces new audio into one latest snapshot without overlapping native calls", async () => {
  const first = deferred<string>();
  const lengths: number[] = [];
  let active = 0;
  let maxActive = 0;
  const stream = createStreamingDictation({
    transcribe: async (pcm) => {
      lengths.push(pcm.byteLength);
      maxActive = Math.max(maxActive, ++active);
      const text = lengths.length === 1 ? await first.promise : "um dois três quatro";
      active--;
      return text;
    },
    onPartial: () => {},
  });
  stream.append(speech(1));
  stream.append(speech(1));
  stream.append(speech(1));
  stream.append(speech(1));
  const finished = stream.finish();
  first.resolve("um");
  assert.equal(await finished, "um dois três quatro");
  assert.deepEqual(lengths, [32000, 128000]);
  assert.equal(maxActive, 1);
});

test("short final syllables are recognized even below the live update threshold", async () => {
  let bytes = 0;
  const stream = createStreamingDictation({
    transcribe: async (pcm) => {
      bytes = pcm.byteLength;
      return "sim";
    },
    onPartial: () => {},
  });
  stream.append(speech(0.2));
  assert.equal(bytes, 0);
  assert.equal(await stream.finish(), "sim");
  assert.equal(bytes, 6400);
});

test("pauses finalize separate phrases and preserve deliberately repeated words", async () => {
  const words = ["sim", "sim, faça isso"];
  const stream = createStreamingDictation({ transcribe: async () => words.shift()!, onPartial: () => {} });
  stream.append(speech(1));
  await stream.idle();
  stream.append(silence(1));
  stream.append(speech(1));
  assert.equal(await stream.finish(), "sim sim, faça isso");
});

test("continuous speech is bounded to 30 seconds and overlapping words appear once", async () => {
  const bytes: number[] = [];
  const words = ["primeira frase último trecho", "último trecho segunda frase"];
  const stream = createStreamingDictation({
    transcribe: async (pcm) => {
      bytes.push(pcm.byteLength);
      return words.shift()!;
    },
    onPartial: () => {},
  });
  stream.append(speech(31));
  assert.equal(await stream.finish(), "primeira frase último trecho segunda frase");
  assert.deepEqual(bytes, [30 * 32000, 1.5 * 32000]);
});

test("cancel suppresses late partials and the final result", async () => {
  const native = deferred<string>();
  const partials: string[] = [];
  const stream = createStreamingDictation({ transcribe: () => native.promise, onPartial: (text) => partials.push(text) });
  stream.append(speech(1));
  stream.cancel();
  native.resolve("late text");
  assert.equal(await stream.finish(), "");
  assert.deepEqual(partials, []);
});

test("silence never calls the recognizer; failures reach finish without unhandled rejections", async () => {
  let calls = 0;
  const stream = createStreamingDictation({
    transcribe: async () => {
      calls++;
      throw new Error("model unavailable");
    },
    onPartial: () => {},
  });
  stream.append(silence(2));
  assert.equal(await stream.finish(), "");
  assert.equal(calls, 0);
  const failed = createStreamingDictation({
    transcribe: async () => {
      throw new Error("model unavailable");
    },
    onPartial: () => {},
  });
  failed.append(speech(1));
  await failed.idle();
  await assert.rejects(failed.finish(), /model unavailable/);
});

test("resampling 44.1 kHz stereo is independent of native buffer boundaries", () => {
  const pcm = Float32Array.from({ length: 44100 * 2 }, (_, i) => Math.sin(Math.floor(i / 2) / 20) * 0.5);
  const expected = createDictationResampler()(pcm, 44100, 2);
  const resample = createDictationResampler();
  const chunks: number[] = [];
  for (let i = 0; i < pcm.length; i += 254) chunks.push(...resample(pcm.subarray(i, i + 254), 44100, 2));
  assert.equal(expected.length, 16000);
  assert.deepEqual(Int16Array.from(chunks), expected);
  assert.deepEqual(createDictationResampler()(Float32Array.of(0.5, -0.5), 8000), Int16Array.of(16384, 16384, -16383, -16383));
});

test("WAV snapshots contain the correct mono PCM16 header and unmodified samples", () => {
  const pcm = Int16Array.of(-32768, 0, 32767);
  const wav = dictationWav(pcm.buffer);
  const view = new DataView(wav);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual(new Int16Array(wav, 44), pcm);
});
