import type { ReactNode } from "react";
import { resolveCodeLanguage } from "../../lib/code-languages";
import { splitRows, wordChanges, type Range } from "../../lib/diff-layout";
import { extensionOf } from "../../lib/diff-comments";
import type { DiffHunk, DiffLine } from "../../lib/diff-parse";
import { highlight, type CodeToken } from "../markdown/highlighter";

export type Decorated = { tokens?: CodeToken[]; words?: Range[] };

export function decorate(hunks: DiffHunk[], path: string, languageReady: boolean): Map<DiffLine, Decorated> {
  const result = new Map<DiffLine, Decorated>();
  const language = resolveCodeLanguage(extensionOf(path));
  for (const hunk of hunks) {
    if (language && languageReady) {
      for (const side of ["remove", "add"] as const) {
        const lines = hunk.lines.filter((line) => line.kind === "context" || line.kind === side);
        const tokens = highlight(lines.map((line) => line.text).join("\n"), language);
        if (tokens) lines.forEach((line, index) => result.set(line, { ...result.get(line), tokens: tokens[index] }));
      }
    }
    for (const { left, right } of splitRows(hunk)) {
      if (left?.kind !== "remove" || right?.kind !== "add") continue;
      const words = wordChanges(left.text, right.text);
      result.set(left, { ...result.get(left), words: words.old });
      result.set(right, { ...result.get(right), words: words.new });
    }
  }
  return result;
}

export function Content({ line, decoration }: { line: DiffLine; decoration?: Decorated }) {
  const words = decoration?.words ?? [];
  const wordClass = line.kind === "add" ? "bg-[var(--diff-add-word)]" : "bg-[var(--diff-remove-word)]";
  const pieces: ReactNode[] = [];
  let offset = 0;
  const segments = decoration?.tokens?.length ? decoration.tokens : [{ content: line.text, className: "" }];
  for (const token of segments) {
    const start = offset;
    const end = offset + token.content.length;
    offset = end;
    const cuts = [start, ...words.flatMap(([from, to]) => [from, to]).filter((at) => at > start && at < end), end];
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      if (from === undefined || to === undefined || from === to) continue;
      const changed = words.some(([a, b]) => from >= a && to <= b);
      pieces.push(
        <span key={`${start}-${from}`} className={`${token.className} ${changed ? wordClass : ""}`}>
          {token.content.slice(from - start, to - start)}
        </span>,
      );
    }
  }
  return <>{pieces.length ? pieces : "​"}</>;
}

export const TINT = { add: "bg-[var(--diff-add)]", remove: "bg-[var(--diff-remove)]", context: "" } as const;
export const MARKER = { add: "+", remove: "−", context: "" } as const;
export const MARKER_COLOR = { add: "text-diff-add", remove: "text-diff-remove", context: "" } as const;
