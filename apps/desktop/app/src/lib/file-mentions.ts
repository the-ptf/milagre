import { formatImageMention } from "@milagre/shared/prompt-parts";

export type PromptToken = { kind: "at" | "slash"; query: string; start: number; end: number };
export function promptToken(draft: string, caret = draft.length): PromptToken | null {
  const match = /(^|\s)([@/])([^\s@"]*)$/.exec(draft.slice(0, caret));
  if (!match) return null;
  return { kind: match[2] === "@" ? "at" : "slash", query: match[3].toLowerCase(), start: match.index + match[1].length, end: caret };
}
export function fileMentionPath(root: string, relative: string): string | null {
  if (!root.startsWith("/") || !relative || relative.startsWith("/") || relative.split("/").some((part) => part === ".." || part === ".")) return null;
  return `${root.replace(/\/$/, "")}/${relative}`;
}
/** Puts `mention` (a `/skill`, or a file as `formatFileMention` writes it) in place of the token, followed by a space. */
export function insertPromptToken(draft: string, token: Pick<PromptToken, "start" | "end">, mention: string): string {
  const suffix = draft.slice(token.end);
  return `${draft.slice(0, token.start)}${mention}${suffix.startsWith(" ") ? "" : " "}${suffix}`;
}
/** Inserts `[Image #N]` mention(s) at `range` (defaulting to the end of `draft`) with surrounding spaces when needed. */
export function insertImageMentions(
  draft: string,
  indices: readonly number[],
  range: { start: number; end: number } = { start: draft.length, end: draft.length },
): { value: string; caret: number } {
  if (!indices.length) return { value: draft, caret: range.end };
  const start = Math.max(0, Math.min(range.start, draft.length));
  const end = Math.max(start, Math.min(range.end, draft.length));
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.startsWith(" ") ? "" : " ";
  const mentions = indices.map(formatImageMention).join(" ");
  const inserted = `${lead}${mentions}${trail}`;
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
