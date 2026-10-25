import assert from "node:assert/strict";
import test from "node:test";
import type { Token } from "markdown-it";
import { markdownTokens } from "./chat-presentation.ts";
import { markdownCellText, markdownColumnWidths, markdownTableRows, type MarkdownNode } from "./markdown-table.ts";

const node = (type: string, children: MarkdownNode[] = []): MarkdownNode => ({ token: { type } as Token, children });

test("table columns share the longest header or body width, clamped to 96-260pt", () => {
  assert.deepEqual(
    markdownColumnWidths([
      ["Header", "x"],
      ["x", "a".repeat(100)],
    ]),
    [96, 260],
  );
  assert.deepEqual(markdownColumnWidths([["a".repeat(20)], ["short"]]), [174]);
  assert.deepEqual(markdownColumnWidths([["a\nb".repeat(20)]]), [96]);
  assert.deepEqual(markdownColumnWidths([["a".repeat(20)]], 0, 20), [224]);
});

test("short tables fill the measured width; wide tables retain their shared widths", () => {
  assert.deepEqual(markdownColumnWidths([["a", "b"]], 340), [170, 170]);
  assert.deepEqual(markdownColumnWidths([["a".repeat(100), "b"]], 340), [260, 96]);
  assert.deepEqual(markdownColumnWidths([["a"]], 400), [400]);
  assert.deepEqual(markdownColumnWidths([["a", "b"]], 100), [96, 96]);
});

test("ragged and empty table rows retain every column without NaN widths", () => {
  assert.deepEqual(markdownColumnWidths([["a"], ["b", "c".repeat(20)], []], 350), [136, 214]);
  assert.deepEqual(markdownColumnWidths([], 350), []);
  assert.deepEqual(markdownColumnWidths([[]], 350), []);
});

test("row collection includes head and body, preserves cell kinds and ignores unrelated nesting", () => {
  const header = node("th_open"),
    body = node("td_open");
  const rows = markdownTableRows([
    node("thead_open", [node("tr_open", [header])]),
    node("tbody_open", [node("tr_open", [body, body]), node("tr_open")]),
    node("blockquote_open", [node("tr_open", [body])]),
  ]);
  assert.deepEqual(rows, [[header], [body, body], []]);
  assert.deepEqual(markdownTableRows([]), []);
});

test("cell measurement uses visible inline labels, code, emoji and escaped pipes, without hidden URLs", () => {
  const tokens = markdownTokens("**Bold** [short](https://example.org/" + "a".repeat(200) + ") `code` a\\|b 😀");
  const inline = tokens.find((token) => token.type === "inline")!;
  assert.equal(markdownCellText([{ token: inline, children: [] }]), "Bold short code a|b 😀");
  assert.deepEqual(markdownColumnWidths([["😀".repeat(10)]]), [99]);
});
