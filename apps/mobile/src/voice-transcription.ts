// iPhone/iPad: Whisper for automatic detection and older devices, Apple for explicit languages when available on iOS 26.
// Android: Whisper on the phone. Elsewhere (a test, the web) there is none and the mic button is not drawn.
export type Transcriber = {
  /** Readies the language model, downloading it when the phone lacks it; `onProgress` gets 0..1 of a download. */
  prepare(language: string, onProgress?: (fraction: number) => void): Promise<void>;
  /** A snapshot of 16 kHz mono PCM16, "" when nothing was said. Project words guide the recognizer directly. */
  transcribe(audio: ArrayBuffer, options: { language: string; terms: readonly string[] }): Promise<string>;
};

export function getTranscriber(): Transcriber | null {
  return null;
}
