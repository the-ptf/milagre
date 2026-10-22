export type PromptPart =
  | { kind: "text"; text: string }
  | { kind: "skill"; text: string; name: string }
  | { kind: "file"; text: string; path: string }
  | { kind: "image"; text: string; index: number };
export type PromptImageBlock<T> = { type: "text"; text: string } | { type: "image"; index: number; image: T };
export function promptParts(
  prompt: string,
  opts: { skills: readonly string[]; files: (path: string) => boolean; images?: number | ((index: number) => boolean) },
): PromptPart[];
export function promptImageBlocks<T>(prompt: string, images?: readonly T[]): PromptImageBlock<T>[];
export function formatFileMention(path: string): string;
export function formatImageMention(index: number): string;
export function imageLabel(index: number): string;
export function skillLabel(name: string): string;
