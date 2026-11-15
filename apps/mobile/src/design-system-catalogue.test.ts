import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolvePalette } from "@milagre/shared/themes";
import {
  COLOR_GROUPS,
  DESIGN_SECTIONS,
  DESIGN_SYSTEM_GROUPS,
  PLATFORM_RULES,
  RADIUS_ROLES,
  SPACE_ROLES,
  TYPE_ROLES,
  designPlatform,
  designSection,
  platformRulesFor,
} from "./design-system-catalogue.ts";
import { radius, space, type } from "./design-tokens.ts";

test("every group has sections, and every section id is used once", () => {
  for (const group of DESIGN_SYSTEM_GROUPS) assert.ok(group.sections.length > 0, `${group.title} has no sections`);
  const ids = DESIGN_SECTIONS.map((section) => section.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(designSection(id)?.id, id);
  assert.equal(designSection("nope"), undefined);
});

test("platform rules have unique ids, both texts, and land on real pages", () => {
  const ids = PLATFORM_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, "rule ids repeat");
  const sections = new Set(DESIGN_SECTIONS.map((section) => section.id));
  for (const rule of PLATFORM_RULES) {
    assert.ok(rule.title && rule.ios && rule.android, `${rule.id} is missing a text`);
    assert.notEqual(rule.ios, rule.android, `${rule.id} says the same on both platforms`);
    assert.ok(rule.sections.length > 0, `${rule.id} shows on no page`);
    for (const section of rule.sections) assert.ok(sections.has(section), `${rule.id}: ${section} is no page`);
  }
});

test("the differences page lists every rule, and each page lists only its own", () => {
  assert.equal(platformRulesFor("platforms").length, PLATFORM_RULES.length);
  for (const section of DESIGN_SECTIONS) {
    if (section.id === "platforms") continue;
    for (const rule of platformRulesFor(section.id)) assert.ok(rule.sections.includes(section.id as never));
  }
});

test("every theme colour has a role on the Colors page, once", () => {
  const listed = COLOR_GROUPS.flatMap((group) => group.colors.map((color) => color.key));
  assert.equal(new Set(listed).size, listed.length, "a colour is listed twice");
  for (const scheme of ["light", "dark"] as const) {
    const palette = resolvePalette("milagre-blue", scheme) as unknown as Record<string, unknown>;
    const colorKeys = Object.keys(palette).filter((key) => typeof palette[key] === "string");
    for (const key of colorKeys) assert.ok(listed.includes(key as never), `${key} has no role on the Colors page`);
  }
});

test("every phone-only Palette key in theme.ts has a role", () => {
  // The keys `Palette` adds to the theme's own, read from its type in theme.ts (the shadows live on the Surfaces page).
  const source = readFileSync(new URL("./theme.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("export type Palette = ThemePalette & {"), source.indexOf("};", source.indexOf("export type Palette")));
  const keys = [...block.matchAll(/^\s+(\w+): string;/gm)].map((match) => match[1]).filter((key) => !key?.startsWith("shadow"));
  assert.ok(keys.length > 10);
  const listed = new Set<string>(COLOR_GROUPS.flatMap((group) => group.colors.map((color) => color.key)));
  for (const key of keys) assert.ok(listed.has(key ?? ""), `${key} has no role on the Colors page`);
});

test("type, spacing and radius roles cover exactly the tokens", () => {
  assert.deepEqual(Object.keys(TYPE_ROLES).sort(), Object.keys(type).sort());
  assert.deepEqual(Object.keys(SPACE_ROLES).sort(), Object.keys(space).sort());
  assert.deepEqual(Object.keys(RADIUS_ROLES).sort(), Object.keys(radius).sort());
});

test("the platform switch defaults to the one the app runs on", () => {
  assert.equal(designPlatform(undefined, "android"), "android");
  assert.equal(designPlatform(undefined, "ios"), "ios");
  assert.equal(designPlatform("android", "ios"), "android");
  assert.equal(designPlatform("windows", "ios"), "ios");
});

test("apps/mobile/DESIGN.md names every platform rule", () => {
  const doc = readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8");
  for (const rule of PLATFORM_RULES) assert.ok(doc.includes(`**${rule.title}.**`), `DESIGN.md has no "${rule.title}" rule`);
});
