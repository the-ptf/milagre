import assert from "node:assert/strict";
import test from "node:test";
import { safeLink, markdownTokens } from "./chat-presentation.ts";

test("links can open web pages but cannot invoke local commands or read local files", () => {
  for (const link of ["https://expo.dev", "http://localhost:3000", "mailto:hello@example.org"]) assert.equal(safeLink(link), link);
  for (const link of ["javascript:alert(1)", "file:///etc/passwd", "milagre-local://connect", "data:text/html,hello", "/Users/me/private"])
    assert.equal(safeLink(link), null);
});

test("streaming markdown closes open bold while code fences and HTML stay inert", () => {
  const tokens = markdownTokens("A **live answer", true);
  assert.ok(tokens[1] !== undefined);
  assert.ok(tokens[1].children?.some((token) => token.type === "strong_open"));
  const code = markdownTokens("```sh\nnpm test", true);
  assert.ok(code[0] !== undefined);
  assert.equal(code[0].type, "fence");
  assert.equal(code[0].content, "npm test");
  assert.ok(!markdownTokens("<script>alert(1)</script>").some((token) => token.type === "html_block"));
});

test("markdown splits into top-level blocks, never inside a code fence or an indented continuation", async () => {
  const { markdownChunks } = await import("./chat-presentation.ts");
  assert.deepEqual(markdownChunks("# Title\n\nFirst paragraph\nstill first\n\n- a\n- b"), ["# Title\n", "First paragraph\nstill first\n", "- a\n- b"]);
  assert.deepEqual(markdownChunks("```sh\nnpm test\n\nnpm run lint\n```\n\nAfter"), ["```sh\nnpm test\n\nnpm run lint\n```\n", "After"]);
  assert.deepEqual(markdownChunks("1. step\n\n    indented code in the item\n\n2. next"), ["1. step\n\n    indented code in the item\n", "2. next"]);
  assert.equal(markdownChunks("a\n\nb\n\n```\nopen fence").join("\n"), "a\n\nb\n\n```\nopen fence");
});

test("Markdown fences format documents, including nested code and streamed emphasis", () => {
  for (const info of ["markdown", "md", "Markdown", "MD title=proposal"]) {
    const tokens = markdownTokens(
      `~~~~${info}\n## Description\n\nA **change** with [a link](https://example.org).\n\n- First\n\n\`\`\`ts\nconst value = 1;\n\`\`\`\n~~~~`,
    );
    assert.ok(tokens.some((token) => token.type === "heading_open"));
    assert.ok(tokens.some((token) => token.type === "bullet_list_open"));
    assert.ok(tokens.some((token) => token.children?.some((child) => child.type === "link_open")));
    assert.equal(tokens.find((token) => token.type === "fence")?.info, "ts");
  }
  const partial = markdownTokens("```markdown\nA **live answer", true);
  assert.ok(partial.some((token) => token.children?.some((child) => child.type === "strong_open")));
  for (const info of ["text", "typescript", "", "markdownish"]) {
    assert.equal(markdownTokens(`\`\`\`${info}\n## Literal\n\`\`\``)[0]?.type, "fence");
  }
});
