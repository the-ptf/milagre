import assert from "node:assert/strict";
import test from "node:test";
import { designIcons, designIconSuggestions } from "./design-icons.mjs";

test("the Lucide set covers the icons phone mockups need", () => {
  assert.ok(Object.keys(designIcons).length > 1800);
  for (const name of ["x", "check", "chevron-left", "chevrons-up-down", "sliders-horizontal", "signal", "wifi", "battery-full", "search", "plus"]) {
    assert.match(designIcons[name], /^<(path|rect|circle|line|polyline|polygon|ellipse) /, name);
  }
  assert.doesNotMatch(Object.values(designIcons).join(""), /<script|on[a-z]+=|href=/i, "markup is geometry only");
  const fills =
    Object.values(designIcons)
      .join("")
      .match(/fill="[^"]*"/g) ?? [];
  assert.ok(fills.length > 0, "dot circles keep fill");
  assert.deepEqual([...new Set(fills)], ['fill="currentColor"'], "only currentColor fills survive");
});

test("suggestions rank close names first", () => {
  assert.deepEqual(designIconSuggestions("chevron-up-down").slice(0, 1), ["chevrons-up-down"]);
});
