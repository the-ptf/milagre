import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_THEME_ID, getTheme, resolvePalette, resolveThemeSettings, themes, isHex, contrastRatio, onColor } from "./index.ts";

test("registers the twelve themes in picker order", () => {
  assert.deepEqual(
    themes.map((t) => t.id),
    [
      "milagre-blue",
      "gray",
      "catppuccin-mocha",
      "catppuccin-macchiato",
      "catppuccin-frappe",
      "tokyo-night",
      "dracula",
      "nord",
      "rose-pine",
      "gruvbox",
      "solarized",
      "one-dark",
    ],
  );
});

test("every theme builds a complete palette in both schemes with readable text", () => {
  for (const theme of themes)
    for (const scheme of ["light", "dark"] as const) {
      const p = resolvePalette(theme.id, scheme);
      assert.ok(isHex(p.page) && isHex(p.ink) && isHex(p.accent), `${theme.id} ${scheme}`);
      assert.equal(p.ansi.length, 16);
      assert.ok(contrastRatio(p.ink, p.page) >= 4.5, `${theme.id} ${scheme} ink`);
      assert.ok(contrastRatio(p.ink2, p.page) >= 4.5, `${theme.id} ${scheme} ink2 ${p.ink2}`);
    }
});

test("tertiary and status text reads at 4.5:1 on the page and on cards, in every theme", () => {
  for (const theme of themes)
    for (const scheme of ["light", "dark"] as const) {
      const p = resolvePalette(theme.id, scheme);
      for (const key of ["ink3", "greenInk", "orangeInk", "redInk"] as const)
        for (const bg of ["page", "surface"] as const)
          assert.ok(contrastRatio(p[key], p[bg]) >= 4.5, `${theme.id} ${scheme} ${key} ${p[key]} on ${bg} ${p[bg]}`);
    }
});

test("a color that already reads keeps its value", () => {
  const p = resolvePalette("milagre-blue", "dark");
  assert.equal(p.greenInk, p.green);
  assert.equal(resolvePalette("catppuccin-mocha", "dark").ink4, "#7f849c");
});

test("Gray keeps today's colors", () => {
  assert.equal(resolvePalette("gray", "light").page, "#fafafb");
  assert.equal(resolvePalette("gray", "dark").page, "#17181a");
  assert.equal(resolvePalette("gray", "light").accent, "#0285ff");
});

test("Milagre Blue's surfaces are blue", () => {
  const { page } = resolvePalette("milagre-blue", "dark");
  assert.notEqual(page, resolvePalette("gray", "dark").page);
});

test("unknown ids and custom without seeds fall back to Milagre Blue", () => {
  const blue = resolvePalette(DEFAULT_THEME_ID, "dark");
  assert.deepEqual(resolvePalette("solarized-ultra", "dark"), blue);
  assert.deepEqual(resolvePalette("custom", "dark", null), blue);
  assert.equal(getTheme("nope"), undefined);
});

test("settings from before theming load Milagre Blue", () => {
  assert.equal(resolveThemeSettings({}), "milagre-blue");
  assert.equal(resolveThemeSettings({ colorTheme: 42 }), "milagre-blue");
  assert.equal(resolveThemeSettings({ colorTheme: "dracula" }), "dracula");
});

test("custom needs the Experimental switch and saved seeds", () => {
  const customTheme = {
    light: { background: "#ffffff", text: "#111111", accent: "#e85d9a" },
    dark: { background: "#1d1430", text: "#efe6ff", accent: "#e85d9a" },
  };
  assert.equal(resolveThemeSettings({ colorTheme: "custom", customThemeEnabled: true, customTheme }), "custom");
  assert.equal(resolveThemeSettings({ colorTheme: "custom", customThemeEnabled: false, customTheme }), "milagre-blue");
  assert.equal(resolveThemeSettings({ colorTheme: "custom", customThemeEnabled: true, customTheme: null }), "milagre-blue");
});

test("every theme's onAccent reads on its accent, in both schemes", () => {
  for (const theme of themes)
    for (const scheme of ["light", "dark"] as const) {
      const p = resolvePalette(theme.id, scheme);
      // Gray must look exactly like the app did before theming: white on #3d9aff in dark (2.89:1), kept on purpose.
      if (theme.id === "gray" && scheme === "dark") continue;
      assert.ok(contrastRatio(p.onAccent, p.accent) >= 3, `${theme.id} ${scheme} onAccent ${p.onAccent} on ${p.accent}`);
    }
});

test("onColor picks the better of white and the page, so text on ink reads", () => {
  assert.equal(onColor("#f2f3f4", "#17181a"), "#17181a");
  assert.equal(onColor("#17181a", "#fafafb"), "#ffffff");
  for (const theme of themes)
    for (const scheme of ["light", "dark"] as const) {
      const p = resolvePalette(theme.id, scheme);
      assert.ok(contrastRatio(onColor(p.ink, p.page), p.ink) >= 4.5, `${theme.id} ${scheme} onInk`);
    }
});
