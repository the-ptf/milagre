export function mentionedFile(path: string, files: readonly string[], root: string): string | undefined;
export function isMentionOfFile(files: readonly string[], root: string): (path: string) => boolean;
export function mentionedFiles(prompt: string, files: readonly string[], root: string): Set<string>;
