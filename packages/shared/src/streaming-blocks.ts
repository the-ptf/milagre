// A streaming answer is re-parsed on every batch. Cutting it into top-level blocks lets the finished ones keep their
// rendered output (each is memoized by text) and leaves only the block being written to parse. Desktop and the phone
// both split with this, so a block means the same text on each.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])( |\t|$)/;
// Reference definitions apply to the whole text, and raw HTML blocks may hold blank lines: don't split those.
const UNSPLITTABLE = /^ {0,3}\[[^\]]+\]:|^ {0,3}<(?:pre|script|style|textarea)\b/im;

/**
 * What one split learned about a text, kept so the next batch of the same answer (which starts with this text)
 * only scans what it added. Every field holds for any text that starts with `text`.
 */
interface SplitState {
  text: string;
  /** Where the text's last line starts: the lines before it are complete and can no longer change. */
  lastLine: number;
  /** A complete line is a reference definition or opens a raw HTML block, so the text stays whole from now on. */
  unsplittable: boolean;
  doubleNewline: boolean;
  /** Where the last block whose first line is complete starts; the blocks before it are final. */
  resumeAt: number;
  before: string[];
  blocks: string[];
}

const EMPTY: SplitState = { text: "", lastLine: 0, unsplittable: false, doubleNewline: false, resumeAt: 0, before: [], blocks: [""] };

// A few answers can stream at once (split view, background Chats), so each keeps its own state.
const RECENT_LIMIT = 8;
const recent: SplitState[] = [];

/** Scans `text` from `from` (a line start where a block starts, or 0) on, after the final blocks `before`. */
function scan(text: string, from: number, before: string[]): Pick<SplitState, "blocks" | "resumeAt" | "before"> {
  const lines = text.slice(from).split("\n");
  const blocks = before.slice();
  let resumeAt = from;
  let resumeBefore = before;
  let start = 0;
  let startOffset = from;
  let offset = from;
  let fence: string | undefined;
  let blankBefore = false;
  let inList = false;
  lines.forEach((line, index) => {
    const lineOffset = offset;
    offset += line.length + 1;
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return;
    }
    if (line.trim() === "") {
      blankBefore = true;
      return;
    }
    const item = LIST_ITEM.test(line);
    // An indented line continues the block before the blank line (code or a list body), and so does a list item in a list.
    if (blankBefore && /^\S/.test(line) && !(item && inList)) {
      // The blank lines between blocks belong to neither.
      let end = index;
      while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
      blocks.push(lines.slice(start, end).join("\n"));
      start = index;
      startOffset = lineOffset;
      inList = false;
      // A block whose first line is complete starts there for good: what follows can't change that line's verdict.
      if (index < lines.length - 1) {
        resumeAt = startOffset;
        resumeBefore = blocks.slice();
      }
    }
    if (item) inList = true;
    blankBefore = false;
    if (marker) fence = marker;
  });
  blocks.push(lines.slice(start).join("\n"));
  return { blocks, resumeAt, before: resumeBefore };
}

function next(previous: SplitState, text: string): SplitState {
  const lastLine = text.lastIndexOf("\n") + 1;
  // Only the lines completed since the previous split still need the whole-text checks.
  const unsplittable = previous.unsplittable || (lastLine > previous.lastLine && UNSPLITTABLE.test(text.slice(previous.lastLine, lastLine)));
  const doubleNewline = previous.doubleNewline || text.includes("\n\n", Math.max(0, previous.text.length - 1));
  const state = { text, lastLine, unsplittable, doubleNewline, resumeAt: previous.resumeAt, before: previous.before };
  if (!doubleNewline || unsplittable || UNSPLITTABLE.test(text.slice(lastLine))) return { ...state, blocks: [text] };
  return { ...state, ...scan(text, previous.resumeAt, previous.before) };
}

/** The text as consecutive top-level blocks, split at blank lines outside code fences. Joined with blank lines they read as the text. */
export function splitStreamingBlocks(text: string): string[] {
  // While an answer streams each text starts with the previous one: continue from there instead of rescanning it all.
  let found = -1;
  for (let index = 0; index < recent.length; index += 1) {
    const candidate = recent[index]!.text;
    if (text.length >= candidate.length && text.startsWith(candidate) && (found < 0 || candidate.length > recent[found]!.text.length)) found = index;
  }
  const previous = found < 0 ? EMPTY : recent[found]!;
  const state = previous.text === text ? previous : next(previous, text);
  if (found >= 0) recent.splice(found, 1);
  recent.unshift(state);
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
  return state.blocks.slice();
}
