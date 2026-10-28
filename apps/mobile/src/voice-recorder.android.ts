import { AudioModule, requestRecordingPermissionsAsync, setAudioModeAsync, setIsAudioActiveAsync, type AudioStream } from "expo-audio";
import { File } from "expo-file-system";
import { RECORDING_LIMIT_SECONDS } from "@milagre/shared/voice-dictation";
import { createTakeLock, VoiceTake, type AudioPort, type RecorderLike, type RecorderStatus } from "./voice-take";

// Android records for Whisper, which reads 16 kHz mono 16-bit WAV: expo-audio's PCM stream writes one, where its
// recorder only makes compressed files. The stream is wrapped as the recorder a take drives (voice-take.ts).

export async function askForMicrophone() {
  const answer = await requestRecordingPermissionsAsync();
  return { granted: answer.granted, canAskAgain: answer.canAskAgain };
}

/** The mic level of a buffer of 16-bit samples, in dB below full scale. */
function decibels(data: ArrayBuffer) {
  const samples = new Int16Array(data);
  if (!samples.length) return -160;
  let sum = 0;
  for (const sample of samples) sum += (sample / 32768) ** 2;
  return 10 * Math.log10(sum / samples.length || 1e-16);
}

function streamRecorder(): RecorderLike {
  let stream: AudioStream | null = null;
  let uri: string | null = null;
  let recording = false;
  let metering = -160;
  let limit: ReturnType<typeof setTimeout> | null = null;
  // The stream and its file start after `record` returns; stopping waits for them, so the file is never left behind.
  let starting: Promise<void> = Promise.resolve();
  const listeners = new Set<(status: RecorderStatus) => void>();
  const emit = (status: RecorderStatus) => listeners.forEach((listener) => listener(status));
  return {
    get uri() {
      return uri;
    },
    get isRecording() {
      return recording;
    },
    addListener(_event, listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    async prepareToRecordAsync() {
      stream = new AudioModule.AudioStream({ sampleRate: 16000, channels: 1, encoding: "int16" });
      stream.addListener("audioStreamBuffer", (buffer) => {
        metering = decibels(buffer.data);
      });
    },
    record({ forDuration }) {
      const current = stream;
      if (!current) return;
      recording = true;
      starting = (async () => {
        await current.start();
        uri = (await current.startFileRecordingAsync({ format: "wav" })).uri;
        if (recording) limit = setTimeout(() => emit({ isFinished: true }), forDuration * 1000);
      })().catch(() => {
        if (!recording) return;
        recording = false;
        emit({ hasError: true });
      });
    },
    getStatus: () => ({ metering }),
    async stop() {
      if (limit) clearTimeout(limit);
      limit = null;
      if (!recording) return;
      recording = false;
      await starting;
      if (limit) clearTimeout(limit);
      limit = null;
      try {
        uri = (await stream?.stopFileRecordingAsync())?.uri ?? uri;
      } finally {
        stream?.stop();
      }
    },
    release() {
      if (limit) clearTimeout(limit);
      stream?.release();
      stream = null;
    },
  };
}

const port: AudioPort = {
  configure: () => setAudioModeAsync({ allowsRecording: true, interruptionMode: "doNotMix", shouldPlayInBackground: false }),
  activate: () => setIsAudioActiveAsync(true),
  deactivate: async () => {
    try {
      await setAudioModeAsync({ allowsRecording: false });
    } finally {
      await setIsAudioActiveAsync(false);
    }
  },
  createRecorder: streamRecorder,
  deleteFile: (path) => new File(path).delete(),
};

const lock = createTakeLock();

/** A new microphone take on the phone's PCM stream. */
export const newVoiceTake = () => new VoiceTake(port, lock, RECORDING_LIMIT_SECONDS);

export type { VoiceTake };
