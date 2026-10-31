import type { AudioStream } from "expo-audio";
import { createDictationResampler } from "@milagre/shared/voice-dictation";
import type { RecorderLike, RecorderStatus } from "./voice-take";

/** Both platforms already ship AudioStream. PCM goes straight to local inference, without encoding or a recording file. */
export function createPcmRecorder(onPcm: (pcm: Int16Array) => void, createStream: () => AudioStream): RecorderLike {
  let stream: AudioStream | null = null;
  let recording = false;
  let stopping = false;
  let ended: (() => void) | null = null;
  let metering = -160;
  let limit: ReturnType<typeof setTimeout> | null = null;
  let starting: Promise<void> = Promise.resolve();
  const resample = createDictationResampler();
  const listeners = new Set<(status: RecorderStatus) => void>();
  const emit = (status: RecorderStatus) => listeners.forEach((listener) => listener(status));
  return {
    uri: null,
    get isRecording() {
      return recording;
    },
    addListener(_event, listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    async prepareToRecordAsync() {
      stream = createStream();
      stream.addListener("audioStreamBuffer", (buffer) => {
        if (!recording) return;
        try {
          const floats = new Float32Array(buffer.data);
          let sum = 0;
          for (const value of floats) sum += value * value;
          metering = 10 * Math.log10(sum / Math.max(1, floats.length) || 1e-16);
          onPcm(resample(floats, buffer.sampleRate, buffer.channels));
        } catch {
          emit({ hasError: true });
        }
      });
      stream.addListener("audioStreamStatus", (status) => {
        if (status.isStreaming) return;
        if (stopping) ended?.();
        else if (recording) emit({ hasError: true });
      });
    },
    record({ forDuration }) {
      const current = stream;
      if (!current) return;
      recording = true;
      starting = current
        .start()
        .then(() => {
          if (recording && !stopping) limit = setTimeout(() => emit({ isFinished: true }), forDuration * 1000);
        })
        .catch(() => {
          if (recording) emit({ hasError: true });
        });
    },
    getStatus: () => ({ metering }),
    async stop() {
      stopping = true;
      if (limit) clearTimeout(limit);
      limit = null;
      await starting;
      const current = stream;
      if (!current?.isStreaming) {
        recording = false;
        return;
      }
      // The stopped event follows the pending PCM events. Accept those buffers until the acknowledgement arrives.
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("The microphone did not finish recording.")), 2000);
          ended = () => {
            clearTimeout(timeout);
            resolve();
          };
          try {
            current.stop();
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
      } finally {
        recording = false;
        ended = null;
      }
    },
    release() {
      recording = false;
      if (limit) clearTimeout(limit);
      stream?.release();
      stream = null;
    },
  };
}
