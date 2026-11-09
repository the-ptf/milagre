import type { DiffHunk, DiffLine } from "./diff-parse.ts";

export type SplitRow = { left?: DiffLine; right?: DiffLine };
export type Range = [start: number, end: number];

/** Old on the left, new on the right; each block of removals is paired with the additions that follow it. */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ left: removed[i], right: added[i] });
    removed = [];
    added = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "context") {
      flush();
      rows.push({ left: line, right: line });
    } else if (line.kind === "remove") {
      // A removal after additions starts a new block.
      if (added.length) flush();
      removed.push(line);
    } else added.push(line);
  }
  flush();
  return rows;
}

const MAX_WORD_DIFF_CHARS = 500;
const MIN_SIMILARITY = 0.4;

function tokenize(text: string) {
  return text.match(/\w+|\s+|[^\w\s]/gu) ?? [];
}

function merge(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const range of ranges) {
    const last = out[out.length - 1];
    if (last && last[1] === range[0]) last[1] = range[1];
    else out.push([range[0], range[1]]);
  }
  return out;
}

/** Character ranges that differ between two lines; none when the lines are too long or too unlike for a word diff to help. */
export function wordChanges(oldText: string, newText: string): { old: Range[]; new: Range[] } {
  const none = { old: [], new: [] };
  if (oldText === newText || oldText.length > MAX_WORD_DIFF_CHARS || newText.length > MAX_WORD_DIFF_CHARS) return none;
  const a = tokenize(oldText);
  const b = tokenize(newText);
  // lcs[i][j] = longest common token run of a[i..] and b[j..].
  // Empty suffixes have score zero; their terminal row and column stay absent.
  const lcs: number[][] = [];
  let nextRow: number[] = [];
  for (let i = a.length - 1; i >= 0; i--) {
    const row: number[] = [];
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
    lcs[i] = row;
    nextRow = row;
  }
  const oldRanges: Range[] = [];
  const newRanges: Range[] = [];
  let i = 0;
  let j = 0;
  let oi = 0;
  let oj = 0;
  let common = 0;
  while (i < a.length || j < b.length) {
    const oldToken = a[i];
    const newToken = b[j];
    if (oldToken !== undefined && newToken !== undefined && oldToken === newToken) {
      common += oldToken.length;
      oi += oldToken.length;
      oj += newToken.length;
      i++;
      j++;
    } else if (newToken !== undefined && (oldToken === undefined || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      newRanges.push([oj, oj + newToken.length]);
      oj += newToken.length;
      j++;
    } else if (oldToken !== undefined) {
      oldRanges.push([oi, oi + oldToken.length]);
      oi += oldToken.length;
      i++;
    }
  }
  const total = oldText.length + newText.length;
  if (total === 0 || (2 * common) / total < MIN_SIMILARITY) return none;
  return { old: merge(oldRanges), new: merge(newRanges) };
}
