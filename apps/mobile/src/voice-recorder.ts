import { AudioModule, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import { File } from "expo-file-system";
import { RECORDING_LIMIT_SECONDS } from "./voice-dictation";
import { createTakeLock, VoiceTake, type AudioPort, type RecorderLike } from "./voice-take";

const PRESET = RecordingPresets.HIGH_QUALITY;
// The native constructor takes platform-flattened options, which is what `useAudioRecorder` builds with its internal helper.
// Dictation only runs on iOS (see voice-transcription), so the iOS half of the preset is the one that applies.
const OPTIONS = {
  extension: PRESET.extension,
  sampleRate: PRESET.sampleRate,
  numberOfChannels: PRESET.numberOfChannels,
  bitRate: PRESET.bitRate,
  isMeteringEnabled: true,
  ...PRESET.ios,
};

export async function askForMicrophone() {
  const answer = await requestRecordingPermissionsAsync();
  return { granted: answer.granted, canAskAgain: answer.canAskAgain };
}

async function releaseAudio() {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Stopping a recording leaves the audio session active; deactivating it lets music that was playing resume.
    await setIsAudioActiveAsync(false);
  }
}

const port: AudioPort = {
  configure: () => setAudioModeAsync({ allowsRecording: true, interruptionMode: "doNotMix", playsInSilentMode: true, shouldPlayInBackground: false }),
  activate: () => setIsAudioActiveAsync(true),
  deactivate: releaseAudio,
  createRecorder: () => new AudioModule.AudioRecorder(OPTIONS) as unknown as RecorderLike,
  deleteFile: (path) => new File(path).delete(),
};

// One lock for the app: a take starts only after every earlier take has given the audio session back.
const lock = createTakeLock();

/** A new microphone take on the phone's recorder. */
export const newVoiceTake = () => new VoiceTake(port, lock, RECORDING_LIMIT_SECONDS);

export type { VoiceTake };
