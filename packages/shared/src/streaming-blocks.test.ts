import { test } from "node:test";
import assert from "node:assert/strict";
import { splitStreamingBlocks } from "./streaming-blocks.ts";

// What every split must equal: the whole text scanned from the start, with no state carried between calls.
function fullSplit(text: string): string[] {
  if (!text.includes("\n\n") || /^ {0,3}\[[^\]]+\]:|^ {0,3}<(?:pre|script|style|textarea)\b/im.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence = "";
  let blankBefore = false;
  let inList = false;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = "";
      continue;
    }
    if (line.trim() === "") {
      blankBefore = true;
      continue;
    }
    const item = /^([-*+]|\d{1,9}[.)])( |\t|$)/.test(line);
    if (blankBefore && /^\S/.test(line) && !(item && inList)) {
      let end = index;
      while (end > start && lines[end - 1]!.trim() === "") end -= 1;
      blocks.push(lines.slice(start, end).join("\n"));
      start = index;
      inList = false;
    }
    if (item) inList = true;
    blankBefore = false;
    if (marker) fence = marker;
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}

const TEXTS = [
  // Fences: blank lines inside, a tilde fence holding backticks, a longer outer fence, one that never closes.
  "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter\n\n~~~\nx\n\n```\nstill tilde\n~~~\n\n````md\n```js\ninner\n```\n\nouter\n````\n\n```sh\n\nopen",
  // Lists: loose items, indented bodies, ordered markers of both kinds, a number that only later becomes an item.
  "Lead\n\n- a\n\n- b\n\n  body\n\n* c\n\n1. one\n\n2) two\n\n10. ten\n\nTail\n\n3\n\n3. item\n\n+ plus\n\nDone",
  // Reference definitions keep the whole text in one block once one arrives, even after it.
  'See [docs] and [api]\n\nMore\n\n[docs]: https://example.test\n\n[api]: <https://api.test> "Title"\n\nAfter',
  // Raw HTML blocks may hold blank lines; a tag that only starts like one does not.
  "Before\n\n<prefix stays\n\n<script>\na\n\nb\n</script>\n\nEnd",
  // Indented code, quotes, headings, tables and runs of blank lines.
  "Para\n\n    code\n\n    more\n\n> quote\n> more\n\n## Heading\n\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\n",
];

test("every prefix of a streamed text splits as the whole text would", () => {
  for (const text of TEXTS) {
    for (let length = 0; length <= text.length; length += 1) {
      const prefix = text.slice(0, length);
      assert.deepEqual(splitStreamingBlocks(prefix), fullSplit(prefix), `prefix ${JSON.stringify(prefix)}`);
    }
  }
});

test("several answers streaming at once, in uneven batches, each split as a whole", () => {
  const cursors = TEXTS.map(() => 0);
  for (let step = 0; cursors.some((cursor, index) => cursor < TEXTS[index]!.length); step += 1) {
    for (const [index, text] of TEXTS.entries()) {
      cursors[index] = Math.min(text.length, cursors[index]! + 1 + ((step * 5 + index * 7) % 13));
      const prefix = text.slice(0, cursors[index]);
      assert.deepEqual(splitStreamingBlocks(prefix), fullSplit(prefix));
    }
  }
});

test("finished blocks are final, the blank lines between blocks belong to neither, and the result is a copy", () => {
  assert.deepEqual(splitStreamingBlocks("One\n\n```\na\n\nb\n```\n\n- x\n\n- y\n\nEnd"), ["One", "```\na\n\nb\n```", "- x\n\n- y", "End"]);
  const blocks = splitStreamingBlocks("Alpha\n\nBeta");
  blocks.push("mutated");
  assert.deepEqual(splitStreamingBlocks("Alpha\n\nBeta"), ["Alpha", "Beta"]);
  // An edit that no longer continues the earlier text splits from scratch.
  assert.deepEqual(splitStreamingBlocks("Alpha\n\nGamma"), ["Alpha", "Gamma"]);
});
