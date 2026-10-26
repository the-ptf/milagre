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
