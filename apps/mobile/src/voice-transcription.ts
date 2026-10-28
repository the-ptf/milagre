// The phone's speech-to-text. iPhone: Apple's on-device dictation (iOS 26), then the AI fix-up. Android: Whisper on the
// phone. Elsewhere (a test, the web) there is none and the mic button is not drawn.
export type Transcriber = {
  /** Apple's recognizer gets the Chat agent's fix-up after it; Whisper's prompt already carries the project's words. */
  polish: boolean;
  /** Readies the language model, downloading it when the phone lacks it; `onProgress` gets 0..1 of a download. */
  prepare(language: string, onProgress?: (fraction: number) => void): Promise<void>;
  /** The spoken text of a recording file, "" when nothing was said. `terms` are the words the project makes likely. */
  transcribe(uri: string, options: { language: string; terms: readonly string[] }): Promise<string>;
};

export function getTranscriber(): Transcriber | null {
  return null;
}
