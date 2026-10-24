import assert from "node:assert/strict";
import test from "node:test";
import { markdownPlainText } from "./plain-text.ts";

test("credentials select without the marks around them", () => {
  assert.equal(
    markdownPlainText("Use these:\n\n- **Email:** `qa@milagre.dev`\n- **Password:** `hunter2!`"),
    "Use these:\n\n• Email: qa@milagre.dev\n• Password: hunter2!",
  );
});

test("paragraphs, headings and code blocks keep their breaks", () => {
  assert.equal(markdownPlainText("## Setup\n\nRun this:\n\n```sh\nnpm ci\nnpm test\n```\n\nDone."), "Setup\n\nRun this:\n\nnpm ci\nnpm test\n\nDone.");
});

test("ordered and nested lists number and indent their items", () => {
  assert.equal(markdownPlainText("3. three\n4. four\n   - inner"), "3. three\n4. four\n  • inner");
});

test("named links keep their address and bare links stay as written", () => {
  assert.equal(
    markdownPlainText("Open [the docs](https://expo.dev/docs) or https://milagre.cloud"),
    "Open the docs (https://expo.dev/docs) or https://milagre.cloud",
  );
});

test("tables read as tab-separated rows", () => {
  assert.equal(markdownPlainText("| Name | Value |\n| --- | --- |\n| user | admin |"), "Name\tValue\nuser\tadmin");
});

test("a reply that is only a code block keeps its indentation", () => {
  assert.equal(markdownPlainText("```py\n    indented()\n```"), "    indented()");
});

test("blank lines inside code are not collapsed", () => {
  assert.equal(markdownPlainText("```\na\n\n\n\nb\n```"), "a\n\n\n\nb");
});

test("paragraph, code block and paragraph sit one blank line apart", () => {
  assert.equal(markdownPlainText("Before\n\n```\ncode\n```\n\nAfter"), "Before\n\ncode\n\nAfter");
});
