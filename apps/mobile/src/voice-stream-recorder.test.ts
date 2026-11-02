import assert from "node:assert/strict";
import test from "node:test";
import type { AudioStream } from "expo-audio";
import { createPcmRecorder } from "./voice-stream-recorder.ts";

class Stream {
  isStreaming = false;
  released = false;
  failStart = false;
  listeners = new Map<string, (event: never) => void>();
  addListener(name: string, listener: (event: never) => void) {
    this.listeners.set(name, listener);
    return { remove: () => this.listeners.delete(name) };
  }
  emit(name: string, event: unknown) {
    this.listeners.get(name)?.(event as never);
  }
  buffer(value: number, rate = 16000, channels = 1) {
    this.emit("audioStreamBuffer", { data: new Float32Array((rate / 10) * channels).fill(value).buffer, sampleRate: rate, channels });
  }
  async start() {
    if (this.failStart) throw new Error("microphone unavailable");
    this.isStreaming = true;
    this.emit("audioStreamStatus", { isStreaming: true });
  }
  stop() {
    this.isStreaming = false;
    // The native stop acknowledgement comes after the already scheduled final PCM event.
    queueMicrotask(() => {
      this.buffer(0.25);
      this.emit("audioStreamStatus", { isStreaming: false });
    });
  }
  release() {
    this.released = true;
  }
}

test("Stop waits for the final native buffer and does not report its acknowledgement as an interruption", async () => {
  const native = new Stream();
  const buffers: Int16Array[] = [];
  const statuses: unknown[] = [];
  const recorder = createPcmRecorder(
    (pcm) => buffers.push(pcm),
    () => native as unknown as AudioStream,
  );
  recorder.addListener("recordingStatusUpdate", (status) => statuses.push(status));
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 30 });
  await Promise.resolve();
  native.buffer(0.5);
  await recorder.stop();
  assert.equal(buffers.length, 2);
  assert.equal(buffers[0]!.length, 1600);
  assert.equal(buffers[1]![0], 8192);
  assert.deepEqual(statuses, []);
  recorder.release();
  assert.equal(native.released, true);
});

test("actual hardware rate and stereo metadata determine resampling", async () => {
  const native = new Stream();
  const buffers: Int16Array[] = [];
  const recorder = createPcmRecorder(
    (pcm) => buffers.push(pcm),
    () => native as unknown as AudioStream,
  );
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 30 });
  await Promise.resolve();
  native.buffer(0.5, 48000, 2);
  assert.equal(buffers[0]!.length, 1600);
  assert.equal(buffers[0]![0], 16384);
  assert.ok(recorder.getStatus().metering! > -7);
  await recorder.stop();
  recorder.release();
});

test("unexpected native stop and start failure reach the take's error handler", async () => {
  for (const failStart of [false, true]) {
    const native = new Stream();
    native.failStart = failStart;
    const statuses: unknown[] = [];
    const recorder = createPcmRecorder(
      () => {},
      () => native as unknown as AudioStream,
    );
    recorder.addListener("recordingStatusUpdate", (status) => statuses.push(status));
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 30 });
    await new Promise((resolve) => setImmediate(resolve));
    if (!failStart) {
      native.isStreaming = false;
      native.emit("audioStreamStatus", { isStreaming: false });
    }
    assert.deepEqual(statuses, [{ hasError: true }]);
    await recorder.stop();
    recorder.release();
  }
});
