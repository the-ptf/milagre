// iPhone/iPad: Whisper for automatic detection and older devices, Apple for explicit languages when available on iOS 26.
// Android: Whisper on the phone. Elsewhere (a test, the web) there is none and the mic button is not drawn.
export type Transcriber = {
  missingModel(language: string, model: string): string | null;
  prepare(language: string, model: string): Promise<void>;
  transcribe(audio: ArrayBuffer, options: { language: string; terms: readonly string[]; model: string }): Promise<string>;
};

export function getTranscriber(): Transcriber | null {
  return null;
}
