import assert from "node:assert/strict";
import test from "node:test";
import { githubHtmlToMarkdown, isGitHubAttachment } from "./github-markdown.ts";

const ASSET = "https://github.com/user-attachments/assets/1a75943a-4133-4d9d-8fa3-99d4a0b689da";

test("a drag-dropped image tag becomes a Markdown image, inside a table too", () => {
  assert.equal(githubHtmlToMarkdown(`<img width="250" alt="Screen" src="${ASSET}" />`), `![Screen](<${ASSET}>)`);
  assert.equal(githubHtmlToMarkdown(`| <img src='${ASSET}'> | b |`), `| ![Image](<${ASSET}>) | b |`);
  assert.equal(githubHtmlToMarkdown("<img alt=x>"), "", "An image without a source goes");
});

test("wrapper tags and line breaks go, their text stays", () => {
  assert.equal(githubHtmlToMarkdown("<details><summary>Notes</summary>\n\nBody<br/>more\n</details>"), "Notes\n\nBody more\n");
  assert.equal(githubHtmlToMarkdown("a <kbd>K</kbd> b"), "a <kbd>K</kbd> b", "Other tags stay as written");
});

test("comments go, across lines too, but not inside code", () => {
  assert.equal(githubHtmlToMarkdown("<!-- triage:v1 -->\nBug fix"), "\nBug fix");
  assert.equal(githubHtmlToMarkdown("a\n<!-- Describe\nthe change -->\nb"), "a\n\nb");
  assert.equal(githubHtmlToMarkdown("```\n<!-- kept -->\n```"), "```\n<!-- kept -->\n```");
});

test("code keeps its tags", () => {
  const fenced = ["```html", `<img src="${ASSET}">`, "```", "`<br>` and <br>"].join("\n");
  assert.equal(githubHtmlToMarkdown(fenced), ["```html", `<img src="${ASSET}">`, "```", "`<br>` and  "].join("\n"));
});

test("only GitHub's attachment addresses count as attachments", () => {
  assert.equal(isGitHubAttachment(ASSET), true);
  assert.equal(isGitHubAttachment("https://github.com/acme/app/assets/12/1a75943a-4133-4d9d-8fa3-99d4a0b689da"), true);
  assert.equal(isGitHubAttachment("https://example.com/user-attachments/assets/1a75943a-4133-4d9d-8fa3-99d4a0b689da"), false);
  assert.equal(isGitHubAttachment(`${ASSET}?x=1`), false);
});
