import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "@milagre/shared/artifact";
import { designActionsMenu, designHtmlIn, designModeLabel, designModeMenu, pageModeChoices, pageModeMenu, shownDesignMode } from "./design-modes-menu.ts";

const design = (tokens: Record<string, unknown>) =>
  ({
    id: "home",
    format: "design",
    version: 2,
    html: "<!doctype html><html><head></head><body></body></html>",
    document: { schemaVersion: 1, width: 390, height: 844, tokens, nodes: [] },
  }) as unknown as Artifact;

test("a design with dark and contrast tokens offers an Appearance section; a one-mode design does not", () => {
  const modal = design({ ink: { light: "#111", dark: "#eee", contrast: "#000" } });
  assert.deepEqual(designModeMenu(design({ ink: "#111" }), undefined), []);
  assert.deepEqual(designModeMenu(modal, "dark"), [
    {
      title: "Appearance",
      items: [
        { id: "mode:light", title: "Light", checked: false },
        { id: "mode:dark", title: "Dark", checked: true },
        { id: "mode:contrast", title: "Increased contrast", checked: false },
      ],
    },
  ]);
  const menu = designActionsMenu({
    shown: modal,
    latest: 2,
    showResolved: false,
    chosen: false,
    sent: false,
    sharing: true,
    mode: "dark",
    extra: [{ items: [{ id: "library:new", title: "New page…" }] }],
  });
  assert.deepEqual(
    menu.map((section) => section.title ?? section.items[0]?.id),
    ["resolved", "choose", "Appearance", "Versions", "share", "library:new", "delete"],
  );
});

test("the shown mode falls back to light when a revision drops it, and the page HTML switches with it", () => {
  const dark = design({ ink: { light: "#111", dark: "#eee" } });
  assert.equal(shownDesignMode(dark, "contrast"), "light");
  assert.equal(designModeLabel(dark, "dark"), "Dark");
  assert.equal(designModeLabel(dark, "light"), "");
  assert.match(designHtmlIn(dark, "dark"), /^<!doctype html><html data-design-mode="dark">/);
  assert.equal(designHtmlIn(dark, undefined), dark.html);
});

test("a page's Appearance offers every mode its designs define and sets each design it fits, light for the rest", () => {
  const home = { ...design({ ink: { light: "#111", dark: "#eee", contrast: "#000" } }), id: "home" } as Artifact;
  const rings = { ...design({ ink: { light: "#111", dark: "#eee" } }), id: "rings" } as Artifact;
  const plain = { ...design({ ink: "#111" }), id: "plain" } as Artifact;
  assert.deepEqual(pageModeMenu([plain], {}), [], "no Dark or Contrast anywhere");
  const items = (chosen: Record<string, "light" | "dark" | "contrast">) =>
    pageModeMenu([home, rings, plain], chosen)[0]?.items.map((item) => [item.id, item.checked]);
  assert.deepEqual(items({}), [
    ["page-mode:light", true],
    ["page-mode:dark", false],
    ["page-mode:contrast", false],
  ]);
  assert.deepEqual(pageModeChoices([home, rings, plain], "page-mode:contrast"), { home: "contrast", rings: "light", plain: "light" });
  assert.deepEqual(
    items({ home: "dark" }),
    [
      ["page-mode:light", false],
      ["page-mode:dark", false],
      ["page-mode:contrast", false],
    ],
    "mixed: nothing checked",
  );
  assert.equal(pageModeChoices([home], "mode:dark"), null);
});

test("a design's menu adds it to the presentation or takes it out, and offers to share the presentation once it has screens", () => {
  const home = design({ ink: "#111" });
  const ids = (presentation: string[]) =>
    designActionsMenu({ shown: home, latest: 2, showResolved: false, chosen: false, sent: false, sharing: true, presentation, mode: undefined, extra: [] })
      .flatMap((section) => section.items)
      .filter((item) => item.id.startsWith("present") || item.id === "share-presentation")
      .map((item) => `${item.id}:${item.title}`);
  assert.deepEqual(ids([]), ["present-toggle:Add to presentation"]);
  assert.deepEqual(ids(["other", "home"]), [
    "present-toggle:Remove from presentation (screen 2)",
    "share-presentation:Share presentation (2 screens)",
    "present-clear:Clear presentation",
  ]);
});
