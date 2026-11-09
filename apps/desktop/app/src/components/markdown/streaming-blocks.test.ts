import { test } from "node:test";
import assert from "node:assert/strict";
import { splitStreamingBlocks } from "./streaming-blocks.ts";

test("splits at blank lines between top-level blocks", () => {
  assert.deepEqual(splitStreamingBlocks("One\n\nTwo\nstill two\n\n\n## Three"), ["One", "Two\nstill two", "## Three"]);
  assert.deepEqual(splitStreamingBlocks("single paragraph\nwith a break"), ["single paragraph\nwith a break"]);
});

test("a blank line inside an open or closed fence is no boundary", () => {
  assert.deepEqual(splitStreamingBlocks("Intro\n\n```js\na\n\nb\n```\n\nAfter"), ["Intro", "```js\na\n\nb\n```", "After"]);
  assert.deepEqual(splitStreamingBlocks("Intro\n\n```js\na\n\nb"), ["Intro", "```js\na\n\nb"]);
});

test("a list keeps its items and indented bodies together", () => {
  const list = "- a\n\n- b\n\n  body\n\n- c";
  assert.deepEqual(splitStreamingBlocks(`Lead\n\n${list}\n\nTail`), ["Lead", list, "Tail"]);
  assert.deepEqual(splitStreamingBlocks("1. a\n\n2. b"), ["1. a\n\n2. b"]);
});

test("trailing blank lines stay out of the last block", () => {
  assert.deepEqual(splitStreamingBlocks("One\n\n"), ["One\n\n"]);
  assert.deepEqual(splitStreamingBlocks("One\n\nTwo\n\n"), ["One", "Two\n\n"]);
});

test("text with reference definitions or raw html blocks is left whole", () => {
  assert.equal(splitStreamingBlocks("See [a]\n\n[a]: https://x.test").length, 1);
  assert.equal(splitStreamingBlocks("<pre>\na\n\nb\n</pre>\n\nAfter").length, 1);
});

test("blocks rejoined with blank lines match the text without its extra blank lines", () => {
  const text = "Intro\n\n- a\n- b\n\n```sh\nx\n\ny\n```\n\n> quote\n\nEnd";
  assert.equal(splitStreamingBlocks(text).join("\n\n"), text);
});

// The split before it continued from the previous batch: every text was scanned whole.
function fullSplit(text: string): string[] {
  const FENCE = /^ {0,3}(`{3,}|~{3,})/;
  const LIST_ITEM = /^([-*+]|\d{1,9}[.)])( |\t|$)/;
  const UNSPLITTABLE = /^ {0,3}\[[^\]]+\]:|^ {0,3}<(?:pre|script|style|textarea)\b/im;
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
    if (blankBefore && /^\S/.test(line) && !(item && inList)) {
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

const STREAMED = [
  "Intro line\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the fence\n\n~~~\nx\n\n```\nstill tilde\n~~~\n\nEnd",
  "Lead\n\n- a\n\n- b\n\n  body\n\n- c\n\n1. one\n\n2. two\n\n10) ten\n\nTail\n\n1\n\n1. late item\n\nDone",
  "See [docs]\n\nMore text\n\n[docs]: https://example.test\n\nAfter",
  "Before\n\n<pre>\na\n\nb\n</pre>\n\nAfter <prefix stays\n\n<pres not html\n\nEnd",
  "Para\n\n    indented code\n\n    more\n\n> quote\n\n## Heading\n\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n",
  "````md\n```js\ninner\n```\n\nstill outer\n````\n\nout\n\n```open forever\n\nnever closes",
];

test("splitting each streamed batch matches splitting the whole text", () => {
  for (const text of STREAMED) {
    for (let length = 0; length <= text.length; length += 1) {
      const prefix = text.slice(0, length);
      assert.deepEqual(splitStreamingBlocks(prefix), fullSplit(prefix), `prefix ${JSON.stringify(prefix)}`);
    }
  }
});

test("batches of several answers interleaved, uneven chunks and a restart match the whole-text split", () => {
  const cursors = STREAMED.map(() => 0);
  let step = 0;
  while (cursors.some((cursor, index) => cursor < STREAMED[index]!.length)) {
    STREAMED.forEach((text, index) => {
      cursors[index] = Math.min(text.length, cursors[index]! + 1 + ((step * 7 + index * 3) % 11));
      const prefix = text.slice(0, cursors[index]);
      assert.deepEqual(splitStreamingBlocks(prefix), fullSplit(prefix));
    });
    step += 1;
  }
  // A text that doesn't continue the previous one (an edit, a new answer) is split from scratch.
  assert.deepEqual(splitStreamingBlocks("Fresh\n\nstart"), ["Fresh", "start"]);
  assert.deepEqual(splitStreamingBlocks("Fresh\n\nstart"), ["Fresh", "start"]);
});

test("fences, lists and reference definitions that arrive later change the split like a whole-text split", () => {
  // A list marker completed in the next batch joins the list.
  assert.deepEqual(splitStreamingBlocks("- a\n\n1"), ["- a", "1"]);
  assert.deepEqual(splitStreamingBlocks("- a\n\n1."), ["- a\n\n1."]);
  // A fence opened in the next batch swallows the blank lines after it.
  assert.deepEqual(splitStreamingBlocks("Intro\n\n``"), ["Intro", "``"]);
  assert.deepEqual(splitStreamingBlocks("Intro\n\n```\na\n\nb"), ["Intro", "```\na\n\nb"]);
  // A reference definition anywhere keeps the whole text in one block.
  assert.deepEqual(splitStreamingBlocks("One\n\nTwo\n\n[x"), ["One", "Two", "[x"]);
  assert.deepEqual(splitStreamingBlocks("One\n\nTwo\n\n[x]: https://x.test"), ["One\n\nTwo\n\n[x]: https://x.test"]);
  assert.deepEqual(splitStreamingBlocks("One\n\nTwo\n\n[x]: https://x.test\n\nThree"), ["One\n\nTwo\n\n[x]: https://x.test\n\nThree"]);
  // "<pre" on the last line opens a raw block only while nothing follows the tag name.
  assert.deepEqual(splitStreamingBlocks("A\n\n<pre"), ["A\n\n<pre"]);
  assert.deepEqual(splitStreamingBlocks("A\n\n<prefix"), ["A", "<prefix"]);
});
