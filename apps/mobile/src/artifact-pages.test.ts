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
} from "./artifact-pages.ts";

test("the page menu offers Canvas when the Chat has designs, then the page's tabs or its title", () => {
  const tabs = [
    { id: "overview", title: "Overview" },
    { id: "headers", title: "Headers" },
  ];
  const both = artifactPageSections({ canvas: true, page: { title: "HTTP", tabs }, current: { kind: "page", tab: "headers" } });
  assert.deepEqual(
    both.flatMap((section) => section.items.map((item) => [item.id, item.title, !!item.checked])),
    [
      ["canvas", "Canvas", false],
      ["page:overview", "Overview", false],
      ["page:headers", "Headers", true],
    ],
  );
  assert.equal(both[1]!.title, "HTTP");
  const plain = artifactPageSections({ canvas: true, page: { title: "HTTP", tabs: [] }, current: { kind: "canvas" } });
  assert.deepEqual(
    plain.flatMap((section) => section.items.map((item) => [item.id, item.title, !!item.checked])),
    [
      ["canvas", "Canvas", true],
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
    version: undefined,
    chosen: undefined,
    tab: undefined,
    comment: undefined,
    requestId: undefined,
  });
  assert.equal(artifactRouteParams({ hostId: "mac", chatId: "/p#1", id: "page", html: true, tab: "headers" }).kind, "html");
});
