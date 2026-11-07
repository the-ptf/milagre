import assert from "node:assert/strict";
import { test } from "node:test";
import { fileLinkFolder, fileLinkName, isMarkdownFile, isWindowsPath, localFileLink } from "./file-link.mjs";

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
