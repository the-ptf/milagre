import assert from "node:assert/strict";
import test from "node:test";
import { markdownTokens } from "./chat-presentation.ts";
import { orderedListLabels } from "./markdown-list.ts";

test("a ten-item list sizes its marker column for two digits", () => {
  const { labels, widest } = orderedListLabels(1, 12);
  assert.deepEqual(labels.slice(8, 12), ["9.", "10.", "11.", "12."]);
  assert.equal(widest, "00.");
});

test("a short list keeps the one-digit column", () => {
  assert.deepEqual(orderedListLabels(1, 3), { labels: ["1.", "2.", "3."], widest: "0." });
});

test("a list continued past 9 after a code block sizes for its own numbers", () => {
  const start = Number(
    markdownTokens("10. ten\n11. eleven")
      .find((token) => token.type === "ordered_list_open")
      ?.attrGet("start"),
  );
  assert.deepEqual(orderedListLabels(start, 2), { labels: ["10.", "11."], widest: "00." });
  assert.equal(orderedListLabels(8, 3).widest, "00.");
});
