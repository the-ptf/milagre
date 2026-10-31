// iPhone/iPad: Whisper for automatic detection and older devices, Apple for explicit languages when available on iOS 26.
// Android: Whisper on the phone. Elsewhere (a test, the web) there is none and the mic button is not drawn.
// `model` is the picked Whisper model (WHISPER_MODELS.phone); Apple's recognizer ignores it.
export type Transcriber = {
  /** The Whisper model a take in this language needs that isn't on the phone yet, or null when nothing has to download. */
  missingModel(language: string, model: string): string | null;
  /** Readies the recognizer (loads the model) so the take's first words don't wait for it. */
  prepare(language: string, model: string): Promise<void>;
  /** A snapshot of 16 kHz mono PCM16, "" when nothing was said. Project words guide the recognizer directly. */
  transcribe(audio: ArrayBuffer, options: { language: string; terms: readonly string[]; model: string }): Promise<string>;
};

export function getTranscriber(): Transcriber | null {
  return null;
}
