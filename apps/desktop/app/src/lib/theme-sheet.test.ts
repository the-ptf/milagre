import assert from "node:assert/strict";
import test from "node:test";
import { resolvePalette } from "@milagre/shared/themes";
import { themeStylesheet } from "./theme-sheet.ts";

test("writes every token, ANSI color and Shiki variable", () => {
  const css = themeStylesheet(resolvePalette("catppuccin-mocha", "dark"));
  assert.match(css, /html:root\s*\{[^}]*--page:\s*#1e1e2e;/);
  assert.match(css, /--hover-2:/);
  assert.match(css, /--line-strong:/);
  assert.match(css, /--ansi-15:/);
  assert.match(css, /--shiki-token-keyword:\s*#cba6f7;/);
  assert.match(css, /--syntax-keyword:\s*#cba6f7;/);
});

test("kebab-cases the palette keys the stylesheet names", () => {
  const css = themeStylesheet(resolvePalette("catppuccin-mocha", "dark"));
  for (const name of ["hover-2", "line-strong", "diff-add-word", "tooltip-bg", "on-accent", "accent-ink", "accent-tint"]) {
    assert.match(css, new RegExp(`--${name}:`), name);
  }
});

test("leaves --purple to Ultracode's brand color", () => {
  assert.doesNotMatch(themeStylesheet(resolvePalette("catppuccin-mocha", "dark")), /--purple:/);
});
