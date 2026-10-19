import test from "node:test";
import assert from "node:assert/strict";
import { isMentionOfFile, mentionedFile, mentionedFiles } from "./prompt-mentions.ts";

const files = ["/repo/src/a.ts", "/repo/docs/my spec.md", "/elsewhere/note.txt"];

test("a mention matches the file under the root or by path suffix", () => {
  assert.equal(mentionedFile("src/a.ts", files, "/repo"), "/repo/src/a.ts");
  assert.equal(mentionedFile("note.txt", files, "/repo"), "/elsewhere/note.txt");
  assert.equal(mentionedFile("a.ts", files, "/repo/"), "/repo/src/a.ts");
  assert.equal(mentionedFile("src/b.ts", files, "/repo"), undefined);
  assert.equal(mentionedFile("", files, "/repo"), undefined);
});

test("mentionedFiles lists the attached files a prompt names inline", () => {
  assert.deepEqual([...mentionedFiles("fix @src/a.ts and @nope.ts", files, "/repo")], ["/repo/src/a.ts"]);
  assert.deepEqual([...mentionedFiles('read @"docs/my spec.md" now', files, "/repo")], ["/repo/docs/my spec.md"]);
  assert.equal(mentionedFiles("fix @src/a.ts", [], "/repo").size, 0);
  assert.equal(mentionedFiles("a stray @ and mail@src/a.ts", files, "/repo").size, 0);
});

test("the predicate follows the message's files only", () => {
  assert.equal(isMentionOfFile(files, "/repo")("src/a.ts"), true);
  assert.equal(isMentionOfFile([], "/repo")("src/a.ts"), false);
});

test("an absolute mention matches the same absolute file", () => {
  assert.equal(mentionedFile("/elsewhere/note.txt", files, "/repo"), "/elsewhere/note.txt");
  assert.deepEqual([...mentionedFiles("see @/elsewhere/note.txt", files, "/repo")], ["/elsewhere/note.txt"]);
  assert.equal(mentionedFile("/other/note.txt", files, "/repo"), undefined);
});

test("same-name files: the root match wins, an ambiguous suffix names nothing", () => {
  const twins = ["/repo/a/index.ts", "/repo/b/index.ts", "/repo/index.ts"];
  assert.equal(mentionedFile("index.ts", twins, "/repo"), "/repo/index.ts");
  assert.equal(mentionedFile("a/index.ts", twins, "/repo"), "/repo/a/index.ts");
  assert.equal(mentionedFile("index.ts", ["/repo/a/index.ts", "/repo/b/index.ts"], "/repo"), undefined);
  assert.equal(mentionedFiles("@index.ts", ["/repo/a/index.ts", "/repo/b/index.ts"], "/repo").size, 0);
});
