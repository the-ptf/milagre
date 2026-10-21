import test from "node:test";
import assert from "node:assert/strict";
import { formatFileMention } from "@milagre/shared/prompt-parts";
import { promptToken, fileMentionPath, insertPromptToken } from "./file-mentions.ts";
test("file queries accept directories and names at the caret, preserving following text", () => {
  assert.deepEqual(promptToken("Look at @src/app.ts please", 19), { kind: "at", query: "src/app.ts", start: 8, end: 19 });
  assert.equal(fileMentionPath("/project/", "src/my photo.png"), "/project/src/my photo.png");
  assert.equal(fileMentionPath("/project", "../secret.png"), null);
  assert.equal(promptToken("mail@example.com", 16), null);
  assert.equal(promptToken("/rev", 4)?.kind, "slash");
});

test("slash selection preserves text after the caret", () => {
  assert.equal(insertPromptToken("/rev explain the failing tests", { start: 0, end: 4 }, "/review"), "/review explain the failing tests");
});

test("a picked file goes in as a mention, quoted when its path has a space", () => {
  assert.equal(insertPromptToken("Look at @my please", { start: 8, end: 11 }, formatFileMention("src/my app.ts")), 'Look at @"src/my app.ts" please');
  assert.equal(insertPromptToken("@pho", { start: 0, end: 4 }, formatFileMention("media/photo.png")), "@media/photo.png ");
});
