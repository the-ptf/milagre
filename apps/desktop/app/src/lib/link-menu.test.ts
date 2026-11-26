import assert from "node:assert/strict";
import test from "node:test";
import { linkMenuEntries, markdownLink, type LinkMenuEntry } from "./link-menu.ts";

const mac = { mac: true, fileManager: "Finder" };
const windows = { mac: false, fileManager: "File Explorer" };
const rows = (entries: LinkMenuEntry[]) => entries.map((entry) => (entry === "divider" ? "—" : `${entry.label}${entry.hint ? ` (${entry.hint})` : ""}`));

test("a web link opens where its click goes under each Settings › Links value", () => {
  assert.deepEqual(rows(linkMenuEntries({ kind: "web", pullRequest: false, openLinksIn: "milagre", panel: true }, mac)), [
    "Browser panel (Click)",
    "Default browser (⌘ Click)",
    "—",
    "Copy link",
    "Copy as Markdown",
  ]);
  assert.deepEqual(rows(linkMenuEntries({ kind: "web", pullRequest: false, openLinksIn: "external", panel: true }, windows)), [
    "Browser panel (Ctrl+Click)",
    "Default browser (Click)",
    "—",
    "Copy link",
    "Copy as Markdown",
  ]);
});

test("Code review shows only for a PR the Chat knows and takes the plain click; without a Browser panel its clicks go to the browser", () => {
  assert.deepEqual(rows(linkMenuEntries({ kind: "web", pullRequest: true, openLinksIn: "milagre", panel: true }, mac)).slice(0, 3), [
    "Code review (Click)",
    "Browser panel",
    "Default browser (⌘ Click)",
  ]);
  assert.deepEqual(rows(linkMenuEntries({ kind: "web", pullRequest: true, openLinksIn: "external", panel: true }, mac)).slice(0, 3), [
    "Code review (Click)",
    "Browser panel (⌘ Click)",
    "Default browser (⇧ Click)",
  ]);
  assert.deepEqual(rows(linkMenuEntries({ kind: "web", pullRequest: false, openLinksIn: "milagre", panel: false }, mac)).slice(0, 1), [
    "Default browser (Click)",
  ]);
  assert.deepEqual(rows(linkMenuEntries({ kind: "web", pullRequest: true, openLinksIn: "external", panel: false }, mac)).slice(0, 2), [
    "Code review (Click)",
    "Default browser (⌘ Click)",
  ]);
});

test("a file link offers the viewer, the editor at its line and reveal on this computer, only the viewer and copies on another", () => {
  assert.deepEqual(rows(linkMenuEntries({ kind: "file", editor: "Cursor", remote: false, relative: true }, mac)), [
    "File viewer (Click)",
    "Cursor",
    "Reveal in Finder",
    "—",
    "Copy path",
    "Copy relative path",
  ]);
  assert.deepEqual(rows(linkMenuEntries({ kind: "file", remote: false, relative: false }, windows)), [
    "File viewer (Click)",
    "Show in File Explorer",
    "—",
    "Copy path",
  ]);
  assert.deepEqual(rows(linkMenuEntries({ kind: "file", editor: "Cursor", remote: true, relative: true }, mac)), [
    "File viewer (Click)",
    "—",
    "Copy path",
    "Copy relative path",
  ]);
});

test("Copy as Markdown escapes what would end the link", () => {
  assert.equal(markdownLink("PR #12", "https://github.com/o/r/pull/12"), "[PR #12](https://github.com/o/r/pull/12)");
  assert.equal(markdownLink("a [b]", "https://x.dev/a (b)"), "[a \\[b\\]](https://x.dev/a%20%28b%29)");
  assert.equal(markdownLink("  ", "https://x.dev"), "[https://x.dev](https://x.dev)");
});
