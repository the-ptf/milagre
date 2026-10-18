import assert from "node:assert/strict";
import test from "node:test";
import { parsePatch } from "./diff-parse.ts";
import { splitRows, wordChanges } from "./diff-layout.ts";

const rows = (patch: string) => splitRows(parsePatch(patch)[0]).map((r) => [r.left?.text ?? null, r.right?.text ?? null]);

test("pairs removals with additions row by row", () => {
  assert.deepEqual(rows("@@ -1,3 +1,3 @@\n a\n-b\n-c\n+B\n+C\n"), [
    ["a", "a"],
    ["b", "B"],
    ["c", "C"],
  ]);
});

test("fills the shorter side with empty cells", () => {
  assert.deepEqual(rows("@@ -1,3 +1,2 @@\n-a\n-b\n-c\n+A\n"), [
    ["a", "A"],
    ["b", null],
    ["c", null],
  ]);
  assert.deepEqual(rows("@@ -1 +1,3 @@\n-a\n+A\n+B\n+C\n"), [
    ["a", "A"],
    [null, "B"],
    [null, "C"],
  ]);
});

test("pure additions and context never pair across blocks", () => {
  assert.deepEqual(rows("@@ -1,2 +1,3 @@\n a\n+x\n b\n"), [
    ["a", "a"],
    [null, "x"],
    ["b", "b"],
  ]);
});

test("separate change blocks pair independently", () => {
  assert.deepEqual(rows("@@ -1,4 +1,4 @@\n-a\n+A\n m\n-b\n+B\n"), [
    ["a", "A"],
    ["m", "m"],
    ["b", "B"],
  ]);
});

test("a removal after additions opens a new block", () => {
  assert.deepEqual(rows("@@ -1,2 +1,2 @@\n+x\n-y\n"), [
    [null, "x"],
    ["y", null],
  ]);
});

test("wordChanges marks only the tokens that differ", () => {
  const { old, new: next } = wordChanges("const total = price * 2;", "const total = cost * 2;");
  assert.deepEqual(old, [[14, 19]]);
  assert.deepEqual(next, [[14, 18]]);
});

test("adjacent changed tokens merge into one range", () => {
  const { old, new: next } = wordChanges("call(a, b)", "call(x, y)");
  assert.deepEqual(
    old.map(([s, e]) => "call(a, b)".slice(s, e)),
    ["a", "b"],
  );
  assert.deepEqual(
    next.map(([s, e]) => "call(x, y)".slice(s, e)),
    ["x", "y"],
  );
  const wide = wordChanges("one two", "uno dos");
  assert.deepEqual(wide, { old: [], new: [] }); // nothing shared, too dissimilar
});

test("identical, long, or dissimilar lines are skipped", () => {
  assert.deepEqual(wordChanges("same", "same"), { old: [], new: [] });
  const long = "x ".repeat(300);
  assert.deepEqual(wordChanges(long, `${long}y`), { old: [], new: [] });
  assert.deepEqual(wordChanges("abcdefghij", "klmnopqrst"), { old: [], new: [] });
});

test("pure insertion marks only the new side", () => {
  const { old, new: next } = wordChanges("foo(a)", "foo(a, b)");
  assert.deepEqual(old, []);
  assert.deepEqual(next, [[5, 8]]);
});

test("word changes handle an exhausted side and empty lines", () => {
  assert.deepEqual(wordChanges("foo(a, b)", "foo(a)"), { old: [[5, 8]], new: [] });
  assert.deepEqual(wordChanges("foo(a)", "foo(a) + b"), { old: [], new: [[6, 10]] });
  assert.deepEqual(wordChanges("foo(a) + b", "foo(a)"), { old: [[6, 10]], new: [] });
  assert.deepEqual(wordChanges("", "foo(a)"), { old: [], new: [] });
  assert.deepEqual(wordChanges("foo(a)", ""), { old: [], new: [] });
});
