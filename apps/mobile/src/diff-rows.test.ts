import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows, wordSegments } from "./diff-rows.ts";

const patch = ["@@ -1,3 +1,3 @@", " const a = 1;", '-const name = "old";', '+const name = "new";', " export { a };", ""].join("\n");

test("a patch becomes a hunk header and numbered lines", () => {
  const rows = diffRows(patch);
  assert.deepEqual(
    rows.map((row) => (row.type === "hunk" ? row.header : `${row.line.kind}:${row.line.oldNumber ?? ""}:${row.line.newNumber ?? ""}`)),
    ["@@ -1,3 +1,3 @@", "context:1:1", "remove:2:", "add::2", "context:3:3"],
  );
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
});

test("a changed pair highlights only the word that changed", () => {
  const [, , removed, added] = diffRows(patch);
  assert.ok(added !== undefined);
  assert.ok(removed !== undefined);
  assert.ok(removed.type === "line" && added.type === "line");
  assert.deepEqual(
    wordSegments(removed.line.text, removed.words)
      .filter((part) => part.changed)
      .map((part) => part.text),
    ["old"],
  );
  assert.deepEqual(
    wordSegments(added.line.text, added.words)
      .filter((part) => part.changed)
      .map((part) => part.text),
    ["new"],
  );
});

test("segments keep the whole text, including an empty line", () => {
  assert.equal(
    wordSegments("abc def", [[4, 7]])
      .map((part) => part.text)
      .join(""),
    "abc def",
  );
  assert.deepEqual(wordSegments("", []), [{ text: "", changed: false }]);
});
