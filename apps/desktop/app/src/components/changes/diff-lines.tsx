import type { CSSProperties, ReactNode } from "react";
import type { ThemedToken } from "shiki/core";
import { resolveCodeLanguage } from "../../lib/code-languages";
import { splitRows, wordChanges, type Range } from "../../lib/diff-layout";
import { extensionOf } from "../../lib/diff-comments";
import type { DiffHunk, DiffLine } from "../../lib/diff-parse";
import { highlight } from "../markdown/highlighter";

// The pieces of a diff row shared by the Changes view (DiffFile) and an edit's diff in the transcript (StepDiff).

export type Decorated = { tokens?: ThemedToken[]; words?: Range[] };

/** Syntax tokens and changed-word ranges for every line of a file's hunks. */
export function decorate(hunks: DiffHunk[], path: string, languageReady: boolean): Map<DiffLine, Decorated> {
  const result = new Map<DiffLine, Decorated>();
  const language = resolveCodeLanguage(extensionOf(path));
  for (const hunk of hunks) {
    if (language && languageReady) {
      // Each side is highlighted as the text it would be in its own file, so strings and comments tokenize across lines.
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
  const segments = decoration?.tokens?.length ? decoration.tokens : [{ content: line.text, htmlStyle: undefined } as ThemedToken];
  for (const token of segments) {
    const start = offset;
    const end = offset + token.content.length;
    offset = end;
    // Split the token at word-range edges so the highlight sits behind the syntax colour.
    const cuts = [start, ...words.flatMap(([from, to]) => [from, to]).filter((at) => at > start && at < end), end];
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      if (from === undefined || to === undefined || from === to) continue;
      const changed = words.some(([a, b]) => from >= a && to <= b);
      pieces.push(
        <span
          key={`${start}-${from}`}
          className={`${decoration?.tokens ? "code-token" : ""} ${changed ? wordClass : ""}`}
          style={token.htmlStyle as CSSProperties | undefined}
        >
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
