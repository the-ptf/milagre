const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])( |\t|$)/;
// Reference definitions apply to the whole text, and raw HTML blocks may hold blank lines: don't split those.
const UNSPLITTABLE = /^ {0,3}\[[^\]]+\]:|^ {0,3}<(?:pre|script|style|textarea)\b/im;

interface SplitState {
  text: string;
  lastLine: number;
  unsplittable: boolean;
  doubleNewline: boolean;
  resumeAt: number;
  before: string[];
  blocks: string[];
}

const EMPTY: SplitState = { text: "", lastLine: 0, unsplittable: false, doubleNewline: false, resumeAt: 0, before: [], blocks: [""] };

const RECENT_LIMIT = 8;
const recent: SplitState[] = [];

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
    if (blankBefore && /^\S/.test(line) && !(item && inList)) {
      let end = index;
      while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
      blocks.push(lines.slice(start, end).join("\n"));
      start = index;
      startOffset = lineOffset;
      inList = false;
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
  const unsplittable = previous.unsplittable || (lastLine > previous.lastLine && UNSPLITTABLE.test(text.slice(previous.lastLine, lastLine)));
  const doubleNewline = previous.doubleNewline || text.includes("\n\n", Math.max(0, previous.text.length - 1));
  const state = { text, lastLine, unsplittable, doubleNewline, resumeAt: previous.resumeAt, before: previous.before };
  if (!doubleNewline || unsplittable || UNSPLITTABLE.test(text.slice(lastLine))) return { ...state, blocks: [text] };
  return { ...state, ...scan(text, previous.resumeAt, previous.before) };
}

/** The text as consecutive top-level blocks, split at blank lines outside code fences. Joined with blank lines they read as the text. */
export function splitStreamingBlocks(text: string): string[] {
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
