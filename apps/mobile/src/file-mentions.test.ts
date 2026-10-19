import { test } from "node:test";
import assert from "node:assert/strict";
import { createKnownFiles, exactMatch, fileQueryAt, isOldMacError, mentionPaths } from "./file-mentions.ts";

test("fileQueryAt finds the @ token before the caret only", () => {
  assert.deepEqual(fileQueryAt("fix @src/a", 10), { start: 4, end: 10, query: "src/a" });
  assert.deepEqual(fileQueryAt("@", 1), { start: 0, end: 1, query: "" });
  assert.equal(fileQueryAt("mail me@host", 12), null);
  assert.equal(fileQueryAt("fix @src/a now", 14), null);
  assert.deepEqual(fileQueryAt("fix @src/a now", 10), { start: 4, end: 10, query: "src/a" });
});
test("the older Mac's refusal is recognised, other errors are not", () => {
  assert.equal(isOldMacError("Command is not available from mobile"), true);
  assert.equal(isOldMacError("offline"), false);
});
test("mentionPaths lists each typed path once, quoted paths whole", () => {
  assert.deepEqual(mentionPaths('see @a.ts and @"b c.ts" and @a.ts, mail x@y.com'), ["a.ts", "b c.ts"]);
  assert.deepEqual(mentionPaths("none"), []);
});
test("a typed path is known only on an exact search result", () => {
  assert.equal(exactMatch(["src/a.ts", "src/a.tsx"], "src/a.ts"), true);
  assert.equal(exactMatch(["src/a.tsx"], "src/a.ts"), false);
  assert.equal(exactMatch([], "alice"), false);
});
test("lookups dedupe, cap, and remember answers per root", () => {
  const known = createKnownFiles();
  assert.deepEqual(known.claim("/w", ["a", "b", "c", "d"]), ["a", "b", "c"]);
  assert.deepEqual(known.claim("/w", ["a", "d"]), ["d"]);
  known.record("/w", "a", true);
  known.record("/w", "b", false);
  known.release("/w", "c");
  assert.equal(known.has("/w", "a"), true);
  assert.equal(known.has("/w", "b"), false);
  assert.equal(known.has("/other", "a"), false);
  assert.deepEqual(known.claim("/w", ["a", "b", "c"]), ["c"]);
  known.seed("/w", "z");
  assert.equal(known.has("/w", "z"), true);
  assert.deepEqual(known.claim("/w", ["z"]), []);
});
