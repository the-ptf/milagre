// On-device transcription needs Apple's SpeechAnalyzer (iOS 26), so Android has none: the mic button is not drawn.
export type Transcriber = {
  /** The locale the audio is transcribed in, kept from the call that asked for it. */
  locale: string;
  /** Downloads the language model when the phone lacks it. */
  prepare(): Promise<void>;
  /** The spoken text of a recording file, "" when nothing was said. */
  transcribe(uri: string): Promise<string>;
};

export function getTranscriber(): Transcriber | null {
  return null;
}
