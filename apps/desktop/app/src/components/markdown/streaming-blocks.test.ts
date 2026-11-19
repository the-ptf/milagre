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
