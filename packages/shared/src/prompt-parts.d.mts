export type PromptPart = { kind: "text"; text: string } | { kind: "skill"; text: string; name: string } | { kind: "file"; text: string; path: string };
export function promptParts(prompt: string, opts: { skills: readonly string[]; files: (path: string) => boolean }): PromptPart[];
export function formatFileMention(path: string): string;
export function skillLabel(name: string): string;
