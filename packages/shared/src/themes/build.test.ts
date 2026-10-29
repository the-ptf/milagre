import assert from "node:assert/strict";
import test from "node:test";
import { buildPalette, ansi, syntax } from "./build.ts";
import { contrastRatio, isHex } from "./color.ts";

const source = {
  page: "#1e1e2e",
  surface: "#313244",
  ink: "#cdd6f4",
  accent: "#cba6f7",
  green: "#a6e3a1",
  orange: "#fab387",
  red: "#f38ba8",
  purple: "#cba6f7",
  ansi: ansi({
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
  }),
  syntax: syntax({
    plain: "#cdd6f4",
    comment: "#7f849c",
    keyword: "#cba6f7",
    string: "#a6e3a1",
    number: "#fab387",
    function: "#89b4fa",
    type: "#f9e2af",
  }),
};

test("fills every token with a hex color", () => {
  const palette = buildPalette(source, "dark");
  for (const [key, value] of Object.entries(palette)) {
    if (key === "ansi") assert.equal((value as string[]).length, 16);
    else if (key === "syntax") assert.ok(Object.values(value as object).every(isHex));
    else assert.ok(isHex(value), `${key} = ${value}`);
  }
});

test("given tokens override derived ones", () => {
  assert.equal(buildPalette({ ...source, hover: "#123456" }, "dark").hover, "#123456");
});

test("ink levels step toward the page and stay readable", () => {
  const p = buildPalette(source, "dark");
  assert.ok(contrastRatio(p.ink, p.page) > contrastRatio(p.ink2, p.page));
  assert.ok(contrastRatio(p.ink2, p.page) >= contrastRatio(p.ink3, p.page));
  assert.ok(contrastRatio(p.ink3, p.page) >= 4.5);
  assert.ok(contrastRatio(p.ink4, p.page) < contrastRatio(p.ink3, p.page));
});

test("dark tints are translucent, light tints are solid", () => {
  assert.equal(buildPalette(source, "dark").accentTint.length, 9);
  assert.equal(buildPalette({ ...source, page: "#eff1f5", surface: "#ffffff", ink: "#4c4f69", accent: "#8839ef" }, "light").accentTint.length, 7);
});

test("ansi fills bright colors from the normal ones", () => {
  const a = ansi({
    black: "#000000",
    red: "#ff0000",
    green: "#00ff00",
    yellow: "#ffff00",
    blue: "#0000ff",
    magenta: "#ff00ff",
    cyan: "#00ffff",
    white: "#cccccc",
    brightWhite: "#ffffff",
  });
  assert.equal(a[9], "#ff0000");
  assert.equal(a[15], "#ffffff");
});
