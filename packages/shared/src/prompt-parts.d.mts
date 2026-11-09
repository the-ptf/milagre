export type PromptPart =
  | { kind: "text"; text: string }
  | { kind: "skill"; text: string; name: string }
  | { kind: "file"; text: string; path: string }
  | { kind: "chat"; text: string; id: number; start: number }
  | { kind: "computer"; text: string; name: string }
  | { kind: "image"; text: string; index: number };
export type PromptImageBlock<T> = { type: "text"; text: string } | { type: "image"; index: number; image: T };
export function promptParts(
  prompt: string,
  opts: {
    skills: readonly string[];
    files: (path: string) => boolean;
    images?: number | ((index: number) => boolean);
    chats?: (id: number) => boolean;
    computers?: (name: string) => boolean;
  },
): PromptPart[];
export function promptImageBlocks<T>(prompt: string, images?: readonly T[]): PromptImageBlock<T>[];
export function formatFileMention(path: string): string;
export function formatImageMention(index: number): string;
export function imageLabel(index: number): string;
export function onlyImageMentions(prompt: string, images: number | ((index: number) => boolean)): boolean;
/** A Chat name from a prompt line: attached `[Image #N]` tokens dropped, or "Image" / "N images" when only they remained. */
export function promptTitle(line: string, images?: number | ((index: number) => boolean)): string;
export function skillLabel(name: string): string;
/** A passage quoted in the composer: a chip until the message is sent, then a blockquote at its head. */
export type ComposerQuote = { id: string; text: string; source?: string };
/** A passage as a Markdown blockquote: `> ` on each line, a bare `>` on blank ones. Empty when it has no text. */
export function quoteMarkdown(passage: string): string;
/** A quote chip for the composer, or null when the passage has no text. */
export function composerQuote(passage: string, source?: string): ComposerQuote | null;
/** Where a quoted passage came from, as its chip names it: "Your message", or "Claude reply" and the like. */
export function quoteSource(from: string | undefined, provider: string | undefined): string;
/** What a composer sends: each quote as a blockquote, a blank line apart, then the typed text, kept as typed. */
export function quotedMessage(quotes: readonly (ComposerQuote | string)[], text: string): string;
/** A stable React key per quote of one message, which may repeat a passage. */
export function quoteKeys(quotes: readonly string[]): { key: string; text: string }[];
/** A message's leading blockquotes and the rest; a body without leading quotes comes back whole. */
export function splitQuotes(body: string): { quotes: string[]; text: string };

export function formatChatMention(id: number): string;
export function chatMentionTokens(prompt: string): { id: number; start: number; end: number }[];
export function formatComputerMention(name: string): string;
export function computerMentionTokens(prompt: string): { name: string; start: number; end: number }[];
