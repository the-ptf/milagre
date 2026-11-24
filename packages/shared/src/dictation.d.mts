export type DictationLanguage = { code: string; name: string; locale: string | null };
export const DICTATION_LANGUAGES: readonly DictationLanguage[];
export function dictationLanguage(value: unknown): string;
export function appleLocale(language: string): string;
export function dictationTerms(context?: {
  projectName?: string;
  branch?: string | null;
  chatTitle?: string;
  chat?: readonly string[];
  files?: readonly string[];
  recent?: readonly string[];
  names?: readonly string[];
}): string[];
export function chatTerms(messages: readonly string[], limit?: number): string[];
export function codeNames(source: string, limit?: number): string[];
export type VocabularyCorrection = { heard: string; spelling: string };
export function composerTerms(draft?: string, selected?: string, attachments?: readonly string[], quotes?: readonly string[]): string[];
export function takeVocabulary(focused: readonly string[], corrections: readonly VocabularyCorrection[], context: readonly string[]): string[];
export function recognitionVocabulary(
  anchor: { draft?: string; selection: { start: number; end: number }; attachments?: string[]; quotes?: string[] },
  context: Promise<{ terms: string[]; corrections?: VocabularyCorrection[] } | null>,
  symbols: boolean,
): { readonly terms: string[]; preview(text: string): string; format(text: string): string };
export function editedCorrection(before: string, after: string, selected?: string): VocabularyCorrection;
export function formatDictation(text: string, corrections: readonly VocabularyCorrection[], symbols: boolean, terms?: readonly string[]): string;
export function snapTerms(text: string, terms: readonly string[]): string;
export function whisperPrompt(terms: readonly string[], language?: string): string;
export type WhisperModel = {
  id: string;
  purpose: string;
  name: string;
  english: boolean;
  accuracy: 1 | 2 | 3;
  speed: 1 | 2 | 3;
  file: string;
  size: number;
  sha256: string;
  url: string;
};
export type WhisperPlatform = "desktop" | "phone";
export function whisperLanguage(language: string, model?: Pick<WhisperModel, "english"> | null): string;
export const WHISPER_MODELS: Record<WhisperPlatform, readonly WhisperModel[]>;
export function whisperModelFor(platform: WhisperPlatform, id: unknown): WhisperModel;
export function whisperText(text: unknown, segments?: readonly { text: unknown }[] | null, prompt?: string): string;
export function silentPcm(samples: Int16Array): boolean;
export type DictationShortcutMode = "hold" | "toggle";
export const DICTATION_SHORTCUT_MODES: readonly { value: DictationShortcutMode; label: string; description: string }[];
export function dictationShortcutMode(value: unknown): DictationShortcutMode;
export type DictationFixModel = "auto" | "claude" | "codex" | "antigravity" | "kiro";
export const DICTATION_FIX_MODELS: readonly { value: DictationFixModel; label: string; name: string; description: string }[];
export function dictationFixModel(value: unknown): DictationFixModel;
export function fixUpProvider(model: unknown, chatProvider?: string): Exclude<DictationFixModel, "auto"> | "pi";
export function fixUpModelName(model: unknown, chatProvider?: string): string;
export function lastDictationStore(
  read: () => string | null,
  write: (text: string) => void,
): { get(): string; save(text: string, correction?: Promise<string>): void };
