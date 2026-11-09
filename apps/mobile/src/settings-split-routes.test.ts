import assert from "node:assert/strict";
import test from "node:test";
import { narrowSettingsRoutes, selectedSettingsRow, wideSettingsRoutes } from "./settings-split-routes.ts";

test("a wide Settings sheet drops the list from its Stack and opens on Appearance when nothing else was asked for", () => {
  assert.deepEqual(wideSettingsRoutes([{ name: "settings" }]), [{ name: "appearance" }]);
  // Opened at a page by its address (Manage accounts): that page, and whatever it opened, stay.
  assert.deepEqual(wideSettingsRoutes([{ name: "settings" }, { name: "accounts" }, { name: "dictation-model" }]), [
    { name: "accounts" },
    { name: "dictation-model" },
  ]);
  assert.equal(wideSettingsRoutes([{ name: "voice" }]), null);
  assert.equal(wideSettingsRoutes([]), null);
});

test("a Settings sheet that turns narrow puts the list back under its pages, so Back returns to it", () => {
  assert.deepEqual(narrowSettingsRoutes([{ name: "computers" }, { name: "computer", params: { id: "a" } }]), [
    { name: "settings" },
    { name: "computers" },
    { name: "computer", params: { id: "a" } },
  ]);
  assert.equal(narrowSettingsRoutes([{ name: "settings" }, { name: "voice" }]), null);
  assert.equal(narrowSettingsRoutes([]), null);
});

test("the sidebar lights the Stack's first page, and a Project by its path", () => {
  assert.equal(selectedSettingsRow([{ name: "computers" }, { name: "computer" }]), "computers");
  assert.equal(selectedSettingsRow([{ name: "project-settings", params: { path: "/work/milagre", name: "milagre" } }]), "project:/work/milagre");
  assert.equal(selectedSettingsRow([{ name: "settings" }, { name: "voice" }]), undefined);
  assert.equal(selectedSettingsRow([]), undefined);
});
