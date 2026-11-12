import assert from "node:assert/strict";
import { test } from "node:test";
import { fileLinkFolder, fileLinkName, fileLinkTarget, isMarkdownFile, isWindowsPath, localFileLink, touchedFileMatches } from "./file-link.mjs";

test("absolute paths open in the viewer", () => {
  assert.deepEqual(localFileLink("/Users/me/repo/docs/spec.md"), { path: "/Users/me/repo/docs/spec.md" });
  assert.deepEqual(localFileLink("/Users/me/repo/a%20b.md"), { path: "/Users/me/repo/a b.md" });
});

test("relative paths resolve against the chat's folder", () => {
  assert.deepEqual(localFileLink("docs/spec.md", "/repo"), { path: "/repo/docs/spec.md" });
  assert.deepEqual(localFileLink("./src/../README.md", "/repo"), { path: "/repo/README.md" });
  assert.equal(localFileLink("docs/spec.md"), null);
  assert.equal(localFileLink("docs/spec.md", ""), null);
});

test("line suffixes and anchors become the line", () => {
  assert.deepEqual(localFileLink("/repo/a.ts:42"), { path: "/repo/a.ts", line: 42 });
  assert.deepEqual(localFileLink("/repo/a.ts:42:7"), { path: "/repo/a.ts", line: 42 });
  assert.deepEqual(localFileLink("src/a.ts#L10-L20", "/repo"), { path: "/repo/src/a.ts", line: 10 });
  assert.deepEqual(localFileLink("/repo/spec.md#goals"), { path: "/repo/spec.md" });
});

test("Windows paths open in the viewer, with either slash", () => {
  assert.deepEqual(localFileLink("C:\\Users\\me\\repo\\spec.md"), { path: "C:\\Users\\me\\repo\\spec.md" });
  assert.deepEqual(localFileLink("C:/Users/me/repo/spec.md:12"), { path: "C:\\Users\\me\\repo\\spec.md", line: 12 });
  // How markdown writes a backslash and a space in a link.
  assert.deepEqual(localFileLink("C:%5CUsers%5Cme%5Cmy%20spec.md#L4"), { path: "C:\\Users\\me\\my spec.md", line: 4 });
  assert.equal(localFileLink("C:\\Users\\me\\"), null);
  assert.equal(localFileLink("C:\\"), null);
});

test("relative links resolve against a Windows folder, and never climb past its drive", () => {
  const root = "C:\\Users\\me\\repo";
  assert.deepEqual(localFileLink("docs/spec.md", root), { path: "C:\\Users\\me\\repo\\docs\\spec.md" });
  assert.deepEqual(localFileLink("docs\\spec.md:7", root), { path: "C:\\Users\\me\\repo\\docs\\spec.md", line: 7 });
  assert.deepEqual(localFileLink("../shared%20report.md:12", root), { path: "C:\\Users\\me\\shared report.md", line: 12 });
  assert.deepEqual(localFileLink("../../../../../a.md", root), { path: "C:\\a.md" });
});

test("a drive letter is the only colon a Windows path gets past the scheme check", () => {
  assert.equal(isWindowsPath("C:\\repo"), true);
  assert.equal(isWindowsPath("c:/repo"), true);
  assert.equal(isWindowsPath("C:%5Crepo"), true);
  assert.equal(isWindowsPath("C:repo"), false);
  assert.equal(isWindowsPath("mailto:a@b.c"), false);
  assert.equal(localFileLink("C:repo"), null);
  assert.equal(localFileLink("ab:\\repo"), null);
});

test("names and folders read both kinds of path", () => {
  assert.equal(fileLinkName("/repo/docs/spec.md"), "spec.md");
  assert.equal(fileLinkName("C:\\repo\\docs\\spec.md"), "spec.md");
  assert.equal(fileLinkFolder("/repo/docs/spec.md"), "/repo/docs");
  assert.equal(fileLinkFolder("/spec.md"), "/");
  assert.equal(fileLinkFolder("C:\\repo\\docs\\spec.md"), "C:\\repo\\docs");
  assert.equal(fileLinkFolder("C:\\spec.md"), "C:\\");
});

test("web links and anchors stay links", () => {
  assert.equal(localFileLink("https://example.com/a.md"), null);
  assert.equal(localFileLink("mailto:a@b.c"), null);
  assert.equal(localFileLink("#section"), null);
  assert.equal(localFileLink("//example.com/a.md"), null);
  assert.equal(localFileLink("file:///etc/passwd"), null);
  assert.equal(localFileLink("/repo/docs/"), null);
  assert.equal(localFileLink("javascript:alert(1)"), null);
});

test("markdown files are recognized by extension", () => {
  assert.equal(isMarkdownFile("spec.md"), true);
  assert.equal(isMarkdownFile("README.MDX"), true);
  assert.equal(isMarkdownFile("notes.markdown"), true);
  assert.equal(isMarkdownFile("main.ts"), false);
});

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

test("a path relative to a subfolder finds the file a step worked on, the latest first", () => {
  // A routine's agent works in .routines/<name> and names its case file from there.
  const written = String.raw`C:\Users\me\Proj\.routines\support\casos\2026-11-11-case.md`;
  const steps = [
    { file: String.raw`C:\Users\me\Proj\.routines\support\INSTRUCTIONS.md` },
    { file: written },
    { file: String.raw`C:\Users\me\Proj\casos-old\2026-11-11-case.md` },
    {},
  ];
  assert.deepEqual(touchedFileMatches("casos/2026-11-11-case.md", steps), [written]);
  assert.deepEqual(touchedFileMatches("./casos/2026-11-11-case.md", steps), [written]);
  // Windows paths compare with either slash and in any case.
  assert.deepEqual(touchedFileMatches(String.raw`Casos\2026-11-11-CASE.md`, steps), [written]);
  assert.deepEqual(touchedFileMatches("src/a.ts", [{ file: "/r/one/src/a.ts" }, { file: "/r/two/src/a.ts" }, { file: "/r/one/src/a.ts" }]), [
    "/r/one/src/a.ts",
    "/r/two/src/a.ts",
  ]);
  // POSIX paths keep their case, and a name must match whole.
  assert.deepEqual(touchedFileMatches("src/A.ts", [{ file: "/r/src/a.ts" }]), []);
  assert.deepEqual(touchedFileMatches("a.ts", [{ file: "/r/src/data.ts" }]), []);
});

test("every file of a change that touched several is a candidate", () => {
  // Codex patches casos/a.md and casos/b.md in one change: the step has no single file, only its files.
  const change = { files: ["/p/.routines/r/casos/a.md", "/p/.routines/r/casos/b.md"] };
  assert.deepEqual(touchedFileMatches("casos/b.md", [change]), ["/p/.routines/r/casos/b.md"]);
  assert.deepEqual(touchedFileMatches("casos/a.md", [{ file: "/p/old/casos/a.md" }, change]), ["/p/.routines/r/casos/a.md", "/p/old/casos/a.md"]);
});

test("a file on a Windows network share is a candidate", () => {
  const share = String.raw`\\server\share\proj\.routines\r\casos\a.md`;
  assert.deepEqual(touchedFileMatches("casos/a.md", [{ file: share }]), [share]);
  assert.deepEqual(touchedFileMatches(String.raw`CASOS\A.md`, [{ file: share }]), [share]);
  assert.deepEqual(touchedFileMatches(share, [{ file: share }]), [], "an absolute path has no fallback");
});

test("absolute, parent-relative and empty paths have no fallback", () => {
  const steps = [{ file: "/r/src/a.ts" }, { file: String.raw`C:\r\src\a.ts` }];
  for (const path of ["", "/r/src/a.ts", String.raw`C:\r\src\a.ts`, "../src/a.ts", "x/../src/a.ts"])
    assert.deepEqual(touchedFileMatches(path, steps), [], path);
  // A step's file that is neither absolute nor a drive or share path is skipped.
  assert.deepEqual(touchedFileMatches("a.ts", [{ file: "src/a.ts" }]), []);
});
