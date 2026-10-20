import test from "node:test";
import assert from "node:assert/strict";
import { promptParts, formatFileMention, skillLabel } from "./prompt-parts.mjs";

test("splits skills and files out of prose and keeps the text verbatim", () => {
  const prompt = "Use /frontend-design to fix @src/surface.test.ts now";
  const parts = promptParts(prompt, { skills: ["frontend-design"], files: (path) => path === "src/surface.test.ts" });
  assert.deepEqual(
    parts.map((part) => part.kind),
    ["text", "skill", "text", "file", "text"],
  );
  const file = parts[3];
  assert.equal(file.kind === "file" && file.path, "src/surface.test.ts");
  assert.equal(parts.map((part) => part.text).join(""), prompt);
});

test("quoted paths keep spaces and trailing punctuation stays text", () => {
  const prompt = 'see @"my app/a b.ts".';
  const parts = promptParts(prompt, { skills: [], files: () => true });
  const file = parts.find((part) => part.kind === "file");
  assert.equal(file?.kind === "file" && file.path, "my app/a b.ts");
  assert.equal(parts.at(-1)?.text, ".");
  assert.equal(parts.map((part) => part.text).join(""), prompt);
});

test("mid-word @ and unknown files never parse", () => {
  assert.ok(promptParts("email me@host.com and @team", { skills: [], files: () => true }).every((part) => part.kind === "text" || part.text === "@team"));
  assert.ok(promptParts("email me@host.com and @team", { skills: [], files: (path) => path !== "team" }).every((part) => part.kind === "text"));
});

test("code spans are text", () => {
  const parts = promptParts("`@src/a.ts`", { skills: [], files: () => true });
  assert.ok(parts.every((part) => part.kind === "text"));
});

test("formatFileMention quotes paths with spaces", () => {
  assert.equal(formatFileMention("a b.ts"), '@"a b.ts"');
  assert.equal(formatFileMention("a.ts"), "@a.ts");
});

test("skillLabel title-cases the slug", () => {
  assert.equal(skillLabel("frontend-design"), "Frontend Design");
  assert.equal(skillLabel("plugin:review-code"), "Review Code");
});
