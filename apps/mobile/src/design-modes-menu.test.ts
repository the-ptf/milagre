import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "@milagre/shared/artifact";
import { designActionsMenu, designHtmlIn, designModeLabel, designModeMenu, shownDesignMode } from "./design-modes-menu.ts";

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
