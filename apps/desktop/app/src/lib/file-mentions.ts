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
