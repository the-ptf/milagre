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

test("finished block tokens come from a cache bounded by entries and characters, least recently used out first", async () => {
  const { cachedMarkdownTokens, textCache } = await import("./chat-presentation.ts");
  const body = "# Saved reply\n\nWith **bold** text";
  assert.equal(cachedMarkdownTokens(body), cachedMarkdownTokens(body), "a remount reuses the tokens");
  assert.deepEqual(cachedMarkdownTokens(body), markdownTokens(body));
  const computed: string[] = [];
  const cache = textCache(
    (text) => {
      computed.push(text);
      return { text };
    },
    { entries: 3, chars: 10, maxText: 6 },
  );
  const first = cache("aa");
  cache("bb");
  cache("cc");
  assert.equal(cache("aa"), first, "a hit returns the same value");
  cache("dd");
  assert.deepEqual(computed, ["aa", "bb", "cc", "dd"]);
  cache("bb");
  assert.deepEqual(computed.slice(4), ["bb"], "past three entries the least recently used (bb, not the reread aa) went");
  cache("aa");
  assert.equal(computed.length, 5);
  cache("eeeee");
  cache("ffffff");
  cache("aa");
  assert.deepEqual(computed.slice(5), ["eeeee", "ffffff", "aa"], "past ten characters the oldest texts went");
  cache("ggggggg");
  cache("ggggggg");
  assert.deepEqual(computed.slice(8), ["ggggggg", "ggggggg"], "a text over the size limit is never kept");
});

// Blank lines that end a chunk change no token: compare without them.
const readChunks = (chunks: string[]) => chunks.map((chunk) => chunk.replace(/\s+$/, ""));
const chunkTokens = (chunks: string[]) => chunks.flatMap((chunk) => markdownTokens(chunk).map(({ type, tag, content, info }) => [type, tag, content, info]));

test("the shared block split cut again by markdownChunks reads like markdownChunks of the whole text", async () => {
  const { markdownChunks } = await import("./chat-presentation.ts");
  const { splitStreamingBlocks } = await import("@milagre/shared/streaming-blocks");
  const texts = [
    "# Title\n\nFirst paragraph\nstill first\n\n- a\n- b\n\n1. step\n\n    indented code in the item\n\n2. next\n\nEnd",
    "Intro\n\n```sh\nnpm test\n\nnpm run lint\n```\n\nAfter\n\n~~~\nx\n\n```\nstill tilde\n~~~\n\n````md\n```js\ninner\n```\n\nouter\n````\n\n```open\n\nnever closes",
    "Lead\n\n- a\n\n- b\n\n  body\n\n- c\n\n10) ten\n\nTail\n\n1\n\n1. late item",
    "See [docs]\n\nMore text\n\n[docs]: https://example.test\n\nAfter",
    "Para\n\n    indented code\n\n> quote\n\n## Heading\n\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n",
  ];
  for (const text of texts) {
    for (let length = 0; length <= text.length; length += 1) {
      const prefix = text.slice(0, length);
      const pieces = splitStreamingBlocks(prefix).flatMap((block) => markdownChunks(block));
      assert.deepEqual(readChunks(pieces), readChunks(markdownChunks(prefix)), `prefix ${JSON.stringify(prefix)}`);
    }
    assert.deepEqual(chunkTokens(splitStreamingBlocks(text).flatMap((block) => markdownChunks(block))), chunkTokens(markdownChunks(text)));
  }
});
