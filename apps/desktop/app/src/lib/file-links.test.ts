import assert from "node:assert/strict";
import test from "node:test";
import { fileLinkTarget, fileSpanIndex, openFirstFound, touchedFileMatches } from "./file-links.ts";

test("relative file paths, with or without a line, are links", () => {
  assert.deepEqual(fileLinkTarget("README.md"), { path: "README.md" });
  assert.deepEqual(fileLinkTarget("app/src/App.tsx:42"), { path: "app/src/App.tsx", line: 42 });
  assert.deepEqual(fileLinkTarget("app/src/App.tsx:42:7"), { path: "app/src/App.tsx", line: 42, column: 7 });
  assert.deepEqual(fileLinkTarget("./electron/main.cjs"), { path: "./electron/main.cjs" });
  assert.deepEqual(fileLinkTarget("package.json"), { path: "package.json" });
  assert.deepEqual(fileLinkTarget("src/index.d.ts:3"), { path: "src/index.d.ts", line: 3 });
  assert.deepEqual(fileLinkTarget("app/src/lib/settings.ts:10-20"), { path: "app/src/lib/settings.ts", line: 10 });
  assert.deepEqual(fileLinkTarget("app/(group)/[id].tsx"), { path: "app/(group)/[id].tsx" });
  assert.deepEqual(fileLinkTarget(".gitignore"), { path: ".gitignore" });
  assert.deepEqual(fileLinkTarget("styles.CSS"), { path: "styles.CSS" });
});

test("plain words, commands, versions and URLs stay code", () => {
  for (const code of [
    "npm test",
    "useState",
    "v1.2.3",
    "1.2.3",
    "https://example.com/a.ts",
    "http://localhost:5180",
    "console.log",
    "Math.max",
    "example.com",
    "e.g.",
    "foo.bar",
    "git status",
    "--flag",
    "a.ts b.ts",
    "",
    "src/",
    "src/utils",
    "file.ts:",
    "file.ts:0",
    "file.ts:x",
    "file.ts:1:2:3",
    "C:\\Users\\a.ts",
    "$HOME/a.ts",
    "~/a.ts",
    "/etc/hosts",
    "/abs/path/a.ts",
    "../outside.ts",
    "a/../b.ts",
    "mailto:a@b.co",
    "foo.tsx()",
    "name@1.2.0",
    "a.ts\nb.ts",
  ]) {
    assert.equal(fileLinkTarget(code), null, code);
  }
});

test("a read or edit step's file is the title's code span", () => {
  assert.equal(fileSpanIndex("Read `App.tsx`", "/r/App.tsx"), 1);
  assert.equal(fileSpanIndex("Edited `App.tsx`", "/r/App.tsx"), 1);
  assert.equal(fileSpanIndex("Created `notes.txt`", "/r/notes.txt"), 1);
  assert.equal(fileSpanIndex("Wrote `notes.txt`", "/r/notes.txt"), 1);
  assert.equal(fileSpanIndex("Ran `npm test`", "/r/x"), -1);
  assert.equal(fileSpanIndex("Read `App.tsx`", undefined), -1);
  assert.equal(fileSpanIndex("Edited 3 files", "/r/x"), -1);
});

test("a path relative to a subfolder finds the file a step worked on, the latest first", () => {
  // A routine's agent works in .routines/<name> and names its case file from there.
  const written = String.raw`C:\Users\me\Proj\.routines\support\casos\2026-11-11-case.md`;
  const files = [String.raw`C:\Users\me\Proj\.routines\support\INSTRUCTIONS.md`, written, String.raw`C:\Users\me\Proj\casos-old\2026-11-11-case.md`];
  assert.deepEqual(touchedFileMatches("casos/2026-11-11-case.md", files), [written]);
  assert.deepEqual(touchedFileMatches("./casos/2026-11-11-case.md", files), [written]);
  // Windows paths compare with either slash and in any case.
  assert.deepEqual(touchedFileMatches(String.raw`Casos\2026-11-11-CASE.md`, files), [written]);
  assert.deepEqual(touchedFileMatches("src/a.ts", ["/r/one/src/a.ts", "/r/two/src/a.ts", "/r/one/src/a.ts"]), ["/r/one/src/a.ts", "/r/two/src/a.ts"]);
  // POSIX paths keep their case, and a name must match whole.
  assert.deepEqual(touchedFileMatches("src/A.ts", ["/r/src/a.ts"]), []);
  assert.deepEqual(touchedFileMatches("a.ts", ["/r/src/data.ts"]), []);
});

test("absolute, parent-relative and empty paths have no fallback", () => {
  const files = ["/r/src/a.ts", String.raw`C:\r\src\a.ts`];
  for (const path of ["", "/r/src/a.ts", String.raw`C:\r\src\a.ts`, "../src/a.ts", "x/../src/a.ts"])
    assert.deepEqual(touchedFileMatches(path, files), [], path);
  // A step's file that is neither absolute nor a drive path is skipped.
  assert.deepEqual(touchedFileMatches("a.ts", ["src/a.ts"]), []);
});

test("opening tries the named path, then each fallback, and reports the first failure", async () => {
  const tried: string[] = [];
  const opener = (present: string[]) => async (path: string) => {
    tried.push(path);
    return present.includes(path) ? { ok: true as const } : { ok: false as const, error: { message: `missing ${path}` } };
  };
  assert.equal(await openFirstFound(opener(["a"]), "a", ["b"]), null);
  assert.deepEqual(tried, ["a"]);
  tried.length = 0;
  assert.equal(await openFirstFound(opener(["c"]), "a", ["b", "c", "d"]), null);
  assert.deepEqual(tried, ["a", "b", "c"]);
  tried.length = 0;
  assert.equal(await openFirstFound(opener([]), "a", ["b"]), "missing a");
  assert.deepEqual(tried, ["a", "b"]);
});
