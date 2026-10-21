import { test } from "node:test";
import assert from "node:assert/strict";
import { promptAccessibilityLabel } from "./prompt-label.ts";

test("a prompt without chips keeps its own text", () => {
  assert.equal(promptAccessibilityLabel([{ kind: "text", text: "just words" }]), undefined);
  assert.equal(promptAccessibilityLabel([]), undefined);
});

test("chips read as their kind and name, never as an object replacement character", () => {
  const label = promptAccessibilityLabel([
    { kind: "text", text: "Check " },
    { kind: "file", text: "@src/app/App.tsx", path: "src/app/App.tsx" },
    { kind: "text", text: " and " },
    { kind: "image", text: "[Image #1]", index: 1 },
    { kind: "text", text: " with " },
    { kind: "skill", text: "/tldr", name: "tldr" },
    { kind: "text", text: " and ping @alice" },
  ]);
  assert.equal(label, "Check file App.tsx and Image #1 with skill Tldr and ping @alice");
  assert.ok(!label?.includes("￼"));
});

test("a chip at either end and a hyphenated skill read naturally", () => {
  assert.equal(
    promptAccessibilityLabel([
      { kind: "skill", text: "/code-review", name: "code-review" },
      { kind: "text", text: "\n\nthis please " },
      { kind: "file", text: "@README.md", path: "README.md" },
    ]),
    "skill Code Review this please file README.md",
  );
});
