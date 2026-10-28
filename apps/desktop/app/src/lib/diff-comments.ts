import { resolveCodeLanguage } from "./code-languages.ts";
import type { DiffHunk, DiffLine } from "./diff-parse";
import type { ChangesMode } from "./pull-request-view";

export type DiffSide = "old" | "new";

export type DiffComment = {
  id: string;
  path: string;
  side: DiffSide;
  start: number;
  end: number;
  /** The selected rows as the diff shows them: a `+`, `-` or space marker, then the text. */
  snippet: string[];
  body: string;
  createdAt: number;
  /** The diff it was written on; a comment from before modes were kept belongs to the uncommitted one. */
  mode?: ChangesMode;
};

export type DiffSelection = Pick<DiffComment, "side" | "start" | "end" | "snippet">;

const MAX_SNIPPET_LINES = 40;
const MARKER = { add: "+", remove: "-", context: " " } as const;

const rowText = (line: DiffLine) => MARKER[line.kind] + line.text;

/** Whether a line is shown in the old (left) or new (right) column of a split view. */
export function onSide(line: DiffLine, side: DiffSide) {
  return line.kind === "context" || line.kind === (side === "old" ? "remove" : "add");
}

const numberOn = (line: DiffLine, side: DiffSide) => (side === "old" ? line.oldNumber : line.newNumber);

export function extensionOf(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : name;
}

/**
 * The comment target for the lines between two indexes of a hunk. `side` is the column of a split view, which keeps
 * only that column's lines; without it (unified) every line in between is kept and the side follows the numbers.
 */
export function selectionFromRows(hunk: DiffHunk, fromRow: number, toRow: number, side?: DiffSide): DiffSelection | undefined {
  const lo = Math.min(fromRow, toRow);
  const hi = Math.max(fromRow, toRow);
  const lines = hunk.lines.slice(lo, hi + 1).filter((line) => !side || onSide(line, side));
  if (lines.length === 0) return undefined;
  const resolved = side ?? (lines.some((line) => line.newNumber !== undefined) ? "new" : "old");
  const numbers = lines.map((line) => numberOn(line, resolved)).filter((value): value is number => value !== undefined);
  if (numbers.length === 0) return undefined;
  return { side: resolved, start: Math.min(...numbers), end: Math.max(...numbers), snippet: lines.map(rowText) };
}

/** Where a comment sits now: the hunk and the indexes of its lines, or undefined once the diff no longer has them. */
export function locateComment(comment: DiffComment, hunks: DiffHunk[]): { hunk: number; lines: number[] } | undefined {
  const { snippet, side, start, end } = comment;
  for (const [h, hunk] of hunks.entries()) {
    const all = hunk.lines.map((line, index) => ({ line, index }));
    // A split selection skips the other column's lines in between, so try that reading too.
    const readings = [all, all.filter(({ line }) => onSide(line, side))];
    for (const indexes of readings) {
      for (let i = 0; i + snippet.length <= indexes.length; i++) {
        const window = indexes.slice(i, i + snippet.length);
        if (!window.every(({ line }, k) => rowText(line) === snippet[k])) continue;
        const numbers = window.map(({ line }) => numberOn(line, side)).filter((value): value is number => value !== undefined);
        if (numbers.length > 0 && Math.min(...numbers) === start && Math.max(...numbers) === end) return { hunk: h, lines: window.map(({ index }) => index) };
      }
    }
  }
  return undefined;
}

/** The lines are gone or changed since the comment was written. */
export function isOutdated(comment: DiffComment, hunksForPath: DiffHunk[]) {
  return locateComment(comment, hunksForPath) === undefined;
}

export function labelFor(comment: Pick<DiffComment, "start" | "end">) {
  return comment.start === comment.end ? `L${comment.start}` : `L${comment.start}–${comment.end}`;
}

function fenced(rows: string[], language: string | undefined) {
  const shown = rows.slice(0, MAX_SNIPPET_LINES);
  if (rows.length > MAX_SNIPPET_LINES) shown.push(`… (${rows.length - MAX_SNIPPET_LINES} more lines)`);
  // A snippet that itself holds a fence needs a longer one around it.
  const longest = Math.max(0, ...rows.flatMap((row) => row.match(/`{3,}/g)?.map((run) => run.length) ?? []));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence + (language ?? ""), ...shown, fence].join("\n");
}

/** The one chat message that carries every comment, each with the lines it is about. */
export function formatCommentsMessage(comments: DiffComment[], { mode, base }: { mode: "uncommitted" | "committed"; base?: string | null }) {
  const scope = mode === "uncommitted" ? "uncommitted changes" : base ? `committed changes against ${base}` : "committed changes";
  const entries = comments.map((comment, index) => {
    const lines = comment.start === comment.end ? `line ${comment.start}` : `lines ${comment.start}–${comment.end}`;
    const language = resolveCodeLanguage(extensionOf(comment.path));
    return `${index + 1}. ${comment.path}, ${lines} (${comment.side}):\n${fenced(comment.snippet, language)}\n${comment.body}`;
  });
  return `Review comments on the diff (${scope}):\n\n${entries.join("\n\n")}`;
}
