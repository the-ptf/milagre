import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactPageSections,
  artifactRouteParams,
  lastArtifactPage,
  pageEntries,
  readPageChoice,
  rememberCanvas,
  rememberPage,
  rememberedTab,
  versionSections,
} from "./artifact-pages.ts";

test("the page menu offers Paradise when the Chat has designs, then the page's tabs or its title", () => {
  const tabs = [
    { id: "overview", title: "Overview" },
    { id: "headers", title: "Headers" },
  ];
  const both = artifactPageSections({ canvas: true, page: { title: "HTTP", tabs }, current: { kind: "page", tab: "headers" } });
  assert.deepEqual(
    both.flatMap((section) => section.items.map((item) => [item.id, item.title, !!item.checked])),
    [
      ["canvas", "Paradise", false],
      ["page:overview", "Overview", false],
      ["page:headers", "Headers", true],
    ],
  );
  assert.equal(both[1]!.title, "HTTP");
  const plain = artifactPageSections({ canvas: true, page: { title: "HTTP", tabs: [] }, current: { kind: "canvas" } });
  assert.deepEqual(
    plain.flatMap((section) => section.items.map((item) => [item.id, item.title, !!item.checked])),
    [
      ["canvas", "Paradise", true],
      ["page:", "HTTP", false],
    ],
  );
  assert.equal(pageEntries(artifactPageSections({ canvas: false, page: { title: "HTTP", tabs: [] }, current: { kind: "page", tab: "" } })), 1);
  assert.equal(pageEntries(artifactPageSections({ canvas: true, page: null, current: { kind: "canvas" } })), 1);
  assert.deepEqual(readPageChoice("page:headers"), { kind: "page", tab: "headers" });
  assert.deepEqual(readPageChoice("canvas"), { kind: "canvas" });
  assert.equal(readPageChoice("share"), null);
});

test("each Chat remembers the page last viewed, the design on its canvas and the tab of its page", () => {
  rememberCanvas("mac", "/p#1", "login");
  rememberPage("mac", "/p#1", "page", "headers");
  assert.deepEqual(lastArtifactPage("mac", "/p#1"), { last: "page", design: "login", page: { id: "page", tab: "headers" } });
  assert.equal(rememberedTab("mac", "/p#1", "page"), "headers");
  assert.equal(rememberedTab("mac", "/p#1", "another"), undefined, "a replaced page starts on its first tab");
  assert.equal(rememberedTab("mac", "/p#2", "page"), undefined);
  rememberCanvas("mac", "/p#1", "signup");
  assert.equal(lastArtifactPage("mac", "/p#1")?.last, "canvas");
});

test("switching pages on the phone replaces every param, clearing a comment the sheet was opened on", () => {
  assert.deepEqual(artifactRouteParams({ hostId: "mac", chatId: "/p#1", id: "login" }), {
    hostId: "mac",
    chatId: "/p#1",
    id: "login",
    kind: undefined,
    library: undefined,
    version: undefined,
    chosen: undefined,
    tab: undefined,
    comment: undefined,
    requestId: undefined,
  });
  assert.equal(artifactRouteParams({ hostId: "mac", chatId: "/p#1", id: "page", html: true, tab: "headers" }).kind, "html");
  assert.equal(artifactRouteParams({ hostId: "mac", chatId: "/p#1", id: "library:home", library: "iphone" }).library, "iphone");
});

test("the Project library's pages come after the Chat's own, and a design's versions list newest first", () => {
  const sections = artifactPageSections({
    canvas: true,
    page: null,
    library: [
      { id: "iphone", name: "iPhone" },
      { id: "kit", name: "Kit" },
    ],
    current: { kind: "library", page: "kit" },
    openLibrary: true,
  });
  assert.deepEqual(
    sections.map((section) => [section.title ?? "", section.items.map((item) => [item.id, !!item.checked])]),
    [
      ["", [["canvas", false]]],
      [
        "Project library",
        [
          ["library:iphone", false],
          ["library:kit", true],
          ["open-library", false],
        ],
      ],
    ],
  );
  assert.deepEqual(readPageChoice("library:kit"), { kind: "library", page: "kit" });
  assert.deepEqual(versionSections(1, 1), []);
  assert.deepEqual(
    versionSections(3, 2)[0]!.items.map((item) => [item.title, !!item.checked]),
    [
      ["Version 3 (latest)", false],
      ["Version 2", true],
      ["Version 1", false],
    ],
  );
});
