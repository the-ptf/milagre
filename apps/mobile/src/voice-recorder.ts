import { AudioModule, requestRecordingPermissionsAsync, setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import { DICTATION_SAMPLE_RATE, RECORDING_LIMIT_SECONDS } from "@milagre/shared/voice-dictation";
import { createPcmRecorder } from "./voice-stream-recorder";
import { createTakeLock, VoiceTake, type AudioPort } from "./voice-take";

export async function askForMicrophone() {
  const answer = await requestRecordingPermissionsAsync();
  return { granted: answer.granted, canAskAgain: answer.canAskAgain };
}

const lock = createTakeLock();

export const newVoiceTake = (onPcm: (pcm: Int16Array) => void) => {
  const port: AudioPort = {
    configure: () => setAudioModeAsync({ allowsRecording: true, interruptionMode: "doNotMix", playsInSilentMode: true, shouldPlayInBackground: false }),
    activate: () => setIsAudioActiveAsync(true),
    deactivate: async () => {
      try {
        await setAudioModeAsync({ allowsRecording: false });
      } finally {
        await setIsAudioActiveAsync(false);
      }
    },
    createRecorder: () => createPcmRecorder(onPcm, () => new AudioModule.AudioStream({ sampleRate: DICTATION_SAMPLE_RATE, channels: 1, encoding: "float32" })),
    deleteFile: () => {},
  };
  return new VoiceTake(port, lock, RECORDING_LIMIT_SECONDS);
};

export type { VoiceTake };
