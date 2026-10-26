import assert from "node:assert/strict";
import { test } from "node:test";
import { isMarkdownFile, localFileLink } from "./file-link.mjs";

test("absolute paths open in the viewer", () => {
  assert.deepEqual(localFileLink("/Users/me/repo/docs/spec.md"), { path: "/Users/me/repo/docs/spec.md" });
  assert.deepEqual(localFileLink("/Users/me/repo/a%20b.md"), { path: "/Users/me/repo/a b.md" });
});

test("relative paths resolve against the chat's folder", () => {
  assert.deepEqual(localFileLink("docs/spec.md", "/repo"), { path: "/repo/docs/spec.md" });
  assert.deepEqual(localFileLink("./src/../README.md", "/repo"), { path: "/repo/README.md" });
  assert.equal(localFileLink("docs/spec.md"), null);
  assert.equal(localFileLink("docs/spec.md", ""), null);
});

test("line suffixes and anchors become the line", () => {
  assert.deepEqual(localFileLink("/repo/a.ts:42"), { path: "/repo/a.ts", line: 42 });
  assert.deepEqual(localFileLink("/repo/a.ts:42:7"), { path: "/repo/a.ts", line: 42 });
  assert.deepEqual(localFileLink("src/a.ts#L10-L20", "/repo"), { path: "/repo/src/a.ts", line: 10 });
  assert.deepEqual(localFileLink("/repo/spec.md#goals"), { path: "/repo/spec.md" });
});

test("web links and anchors stay links", () => {
  assert.equal(localFileLink("https://example.com/a.md"), null);
  assert.equal(localFileLink("mailto:a@b.c"), null);
  assert.equal(localFileLink("#section"), null);
  assert.equal(localFileLink("//example.com/a.md"), null);
  assert.equal(localFileLink("file:///etc/passwd"), null);
  assert.equal(localFileLink("/repo/docs/"), null);
  assert.equal(localFileLink("javascript:alert(1)"), null);
});

test("markdown files are recognized by extension", () => {
  assert.equal(isMarkdownFile("spec.md"), true);
  assert.equal(isMarkdownFile("README.MDX"), true);
  assert.equal(isMarkdownFile("notes.markdown"), true);
  assert.equal(isMarkdownFile("main.ts"), false);
});
