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
const answering = (results: Record<string, string[]>, log: string[] = []) => ({
  call: async <T>(_method: string, args: unknown[]) => {
    log.push(String(args[1]));
    return (results[String(args[1])] ?? []) as T;
  },
});

test("resolve confirms exact matches only and remembers answers per root", async () => {
  const known = createKnownFiles();
  const log: string[] = [];
  const client = answering({ "a.ts": ["a.ts", "b/a.ts"], b: ["b.ts"] }, log);
  await known.resolve(client, "/w", ["a.ts", "b", "nope"]);
  assert.equal(known.has("/w", "a.ts"), true);
  assert.equal(known.has("/w", "b"), false);
  assert.equal(known.has("/other", "a.ts"), false);
  await known.resolve(client, "/w", ["a.ts", "b"]);
  assert.deepEqual(log, ["a.ts", "b", "nope"]);
  known.seed("/w", "z");
  assert.deepEqual(known.unchecked("/w", ["z", "q", "r", "s", "t"]), ["q", "r", "s"]);
});
test("resolve shares a lookup the live hook already started", async () => {
  const known = createKnownFiles();
  let calls = 0;
  let answer: (value: string[]) => void = () => {};
  const client = {
    call: <T>() => {
      calls++;
      return new Promise<T>((done) => (answer = done as (value: string[]) => void));
    },
  };
  const live = known.lookup(client, "/w", "a.ts");
  const send = known.resolve(client, "/w", ["a.ts"]);
  answer(["a.ts"]);
  await Promise.all([live, send]);
  assert.equal(calls, 1);
  assert.equal(known.has("/w", "a.ts"), true);
});
test("resolve gives up after the timeout and leaves the path unconfirmed", async () => {
  const known = createKnownFiles();
  const slow = { call: <T>() => new Promise<T>(() => {}) };
  const started = Date.now();
  await known.resolve(slow, "/w", ["a.ts"], 30);
  assert.ok(Date.now() - started < 500);
  assert.equal(known.has("/w", "a.ts"), false);
  assert.deepEqual(known.unchecked("/w", ["a.ts"]), ["a.ts"]);
});
test("a failed lookup is unconfirmed and asked again, an old Mac's is not", async () => {
  const known = createKnownFiles();
  const failing = (message: string) => ({ call: <T>() => Promise.reject(new Error(message)) as Promise<T> });
  await known.resolve(failing("offline"), "/w", ["a.ts"]);
  assert.deepEqual(known.unchecked("/w", ["a.ts"]), ["a.ts"]);
  await known.resolve(failing("Command is not available from mobile"), "/w", ["a.ts"]);
  assert.deepEqual(known.unchecked("/w", ["a.ts"]), []);
  assert.equal(known.has("/w", "a.ts"), false);
});
