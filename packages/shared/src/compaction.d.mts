import type { ChatMessage, CompactionContext, ContextUsage, ImageAttachment } from "./model.ts";

export const COMPACT_COMMAND: "/compact";
export function isCompaction(message: ChatMessage | undefined): message is ChatMessage & { context: CompactionContext };
/** `before` and `after` are formatted token counts, null until known (`after` only once done). */
export function compactionLabel(context: CompactionContext): { title: string; before: string | null; after: string | null };
export function compactionText(context: CompactionContext): string;
export function compactionMessage(usage?: ContextUsage | null): {
  body: string;
  prompt: string;
  images: ImageAttachment[];
  files: string[];
  context: CompactionContext;
};

export function compactionContext(message: { context?: unknown } | undefined): CompactionContext | null;
