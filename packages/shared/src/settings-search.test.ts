import assert from "node:assert/strict";
import test from "node:test";
import { foldSearchText, searchRanges, searchSettings, searchTrail, type SettingsSearchEntry } from "./settings-search.ts";

const entries: SettingsSearchEntry[] = [
  { page: "general", title: "General" },
  { page: "general", title: "Show usage in sidebar", group: "Plan usage" },
  { page: "usage", title: "Usage", keywords: "token cost spend" },
  { page: "appearance", title: "Sidebar usage", group: "Layout", description: "One row per provider" },
  { page: "notifications", title: "Notificações", keywords: "alerts" },
  { page: "chat", title: "Chat width", group: "Layout" },
];
const titles = (query: string) => searchSettings(entries, query).map((hit) => hit.entry.title);

test("a title that starts with the query comes before one that only contains it", () => {
  assert.deepEqual(titles("usage"), ["Usage", "Show usage in sidebar", "Sidebar usage"]);
});

test("every word must match, in any field", () => {
  assert.deepEqual(titles("sidebar usage"), ["Sidebar usage", "Show usage in sidebar"]);
  assert.deepEqual(titles("layout width"), ["Chat width"]);
  assert.deepEqual(titles("token"), ["Usage"]);
  assert.deepEqual(titles("provider"), ["Sidebar usage"]);
  assert.deepEqual(titles("nothing here"), []);
});

test("the page's own name is searched through pageTitle", () => {
  assert.deepEqual(
    searchSettings(entries, "look", (page) => (page === "appearance" ? "Appearance look" : page)).map((hit) => hit.entry.title),
    ["Sidebar usage"],
  );
});

test("accents and case don't matter", () => {
  assert.equal(foldSearchText("Notificações"), "notificacoes");
  assert.deepEqual(titles("NOTIFICACOES"), ["Notificações"]);
});

test("ranges mark each word once, at a word's start when it can", () => {
  assert.deepEqual(searchRanges("Show usage in sidebar", "side usa"), [
    [5, 8],
    [14, 18],
  ]);
  assert.deepEqual(searchRanges("Sidebar usage", "sidebar usage"), [
    [0, 7],
    [8, 13],
  ]);
  assert.deepEqual(searchRanges("Message", "ss"), [[2, 4]]);
  assert.deepEqual(searchRanges("Chat", ""), []);
});

test("an empty query finds nothing and the same row named twice shows once", () => {
  assert.deepEqual(titles("   "), []);
  const twice = [...entries, { page: "general", title: "Show usage in sidebar", group: "Plan usage" }];
  assert.equal(searchSettings(twice, "show usage").length, 1);
});

test("the trail names the page, then the card", () => {
  assert.equal(searchTrail({ page: "chat", title: "Chat width", group: "Layout" }, "Chat"), "Chat › Layout");
  assert.equal(searchTrail({ page: "chat", title: "Chat" }, "Chat"), "Chat");
});
