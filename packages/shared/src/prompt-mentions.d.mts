export const PROMPT_PLACEHOLDER: string;
export function mentionedFile(path: string, files: readonly string[], root: string): string | undefined;
export function isMentionOfFile(files: readonly string[], root: string): (path: string) => boolean;
export function mentionedFiles(prompt: string, files: readonly string[], root: string): Set<string>;
export function mentionedImages(prompt: string, count: number): Set<number>;
export function shiftImageMentions(prompt: string, removedIndex: number): string;
export function remapImageMentions(prompt: string, indices: readonly number[]): string;
export function editImageMentions(
  previous: string,
  next: string,
  images: number,
  selection?: { start: number; end: number },
): { value: string; caret: number | null };

export type MentionChat = { id: number; title: string; branch: string; at: number; lastAt?: number; available: boolean };
export function chatMentionChoices(state: Pick<import("./model.ts").CoordinatorState, "sessions" | "worktrees">): MentionChat[];
export function matchingMentionChats(chats: readonly MentionChat[], query: string, currentId?: number): MentionChat[];

export type MentionComputer = { id: string; name: string; online: boolean; self?: boolean };
export function matchingMentionComputers(computers: readonly MentionComputer[], query: string): MentionComputer[];

export type ShownSpan = { start: number; end: number; shownStart: number; shownEnd: number };
export type ShownPrompt = { text: string; spans: ShownSpan[] };
export function shownPrompt(parts: readonly import("./prompt-parts.d.mts").PromptPart[], title: (id: number) => string | undefined): ShownPrompt;
export function shownOffset(spans: readonly ShownSpan[], offset: number): number;
export function draftOffset(spans: readonly ShownSpan[], offset: number, edge?: "start" | "end"): number;
export function shownSelection(spans: readonly ShownSpan[], selection: { start: number; end: number }): { start: number; end: number };
export function draftSelection(spans: readonly ShownSpan[], selection: { start: number; end: number }): { start: number; end: number };
export function editShownPrompt(
  draft: string,
  shown: ShownPrompt,
  next: string,
  selection?: { start: number; end: number },
): { value: string; caret: number | null };
