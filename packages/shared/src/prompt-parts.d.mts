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
export function onlyImageMentions(prompt: string, images: number | ((index: number) => boolean)): boolean;
/** A Chat name from a prompt line: attached `[Image #N]` tokens dropped, or "Image" / "N images" when only they remained. */
export function promptTitle(line: string, images?: number | ((index: number) => boolean)): string;
export function skillLabel(name: string): string;
