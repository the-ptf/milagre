// A streaming answer is re-parsed on every batch. Cutting it into top-level blocks lets the finished ones keep their
// rendered output (each is memoized by text) and leaves only the block being written to parse.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])( |\t|$)/;
// Reference definitions apply to the whole text, and raw HTML blocks may hold blank lines: don't split those.
const UNSPLITTABLE = /^ {0,3}\[[^\]]+\]:|^ {0,3}<(?:pre|script|style|textarea)\b/im;

/** The text as consecutive top-level blocks, split at blank lines outside code fences. Joined with blank lines they read as the text. */
export function splitStreamingBlocks(text: string): string[] {
  if (!text.includes("\n\n") || UNSPLITTABLE.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: string | undefined;
  let blankBefore = false;
  let inList = false;
  lines.forEach((line, index) => {
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
      inList = false;
    }
    if (item) inList = true;
    blankBefore = false;
    if (marker) fence = marker;
  });
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}
