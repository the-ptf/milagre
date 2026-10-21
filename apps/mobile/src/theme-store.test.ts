import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PHONE_THEME, getThemeSettings, initThemeStore, parsePhoneThemeSettings, setThemeSettings, subscribeTheme } from "./theme-store.ts";

const customTheme = {
  light: { background: "#ffffff", text: "#111111", accent: "#e85d9a" },
  dark: { background: "#1d1430", text: "#efe6ff", accent: "#e85d9a" },
};

test("provider icons default to original and retain a valid simplified choice", () => {
  assert.equal(parsePhoneThemeSettings(null).providerIcons, "original");
  assert.equal(parsePhoneThemeSettings(JSON.stringify({ providerIcons: "simplified" })).providerIcons, "simplified");
  assert.equal(parsePhoneThemeSettings(JSON.stringify({ providerIcons: "unknown" })).providerIcons, "original");
});

test("nothing saved means Milagre Blue following the system", () => {
  assert.deepEqual(parsePhoneThemeSettings(null), DEFAULT_PHONE_THEME);
  assert.equal(DEFAULT_PHONE_THEME.colorTheme, "milagre-blue");
  assert.equal(DEFAULT_PHONE_THEME.mode, "system");
});

test("garbage and unknown values fall back", () => {
  assert.deepEqual(parsePhoneThemeSettings("{not json"), DEFAULT_PHONE_THEME);
  assert.deepEqual(parsePhoneThemeSettings("null"), DEFAULT_PHONE_THEME);
  assert.equal(parsePhoneThemeSettings(JSON.stringify({ colorTheme: "neon", mode: "sepia" })).colorTheme, "milagre-blue");
  assert.equal(parsePhoneThemeSettings(JSON.stringify({ mode: "sepia" })).mode, "system");
  assert.equal(parsePhoneThemeSettings(JSON.stringify({ mode: "dark" })).mode, "dark");
});

test("custom with the switch off loads Milagre Blue and keeps the seeds", () => {
  const parsed = parsePhoneThemeSettings(JSON.stringify({ colorTheme: "custom", customThemeEnabled: false, customTheme }));
  assert.equal(parsed.colorTheme, "milagre-blue");
  assert.deepEqual(parsed.customTheme, customTheme);
});

test("an invalid custom theme is dropped", () => {
  const bad = { ...customTheme, dark: { ...customTheme.dark, accent: "pink" } };
  assert.equal(parsePhoneThemeSettings(JSON.stringify({ customTheme: bad })).customTheme, null);
});

test("changes persist and notify", async () => {
  let stored: string | null = JSON.stringify({ colorTheme: "nord" });
  await initThemeStore({ read: async () => stored, save: async (raw) => void (stored = raw) });
  assert.equal(getThemeSettings().colorTheme, "nord");
  let calls = 0;
  const off = subscribeTheme(() => calls++);
  setThemeSettings({ colorTheme: "dracula" });
  off();
  setThemeSettings({ mode: "dark" });
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(JSON.parse(stored!).colorTheme, "dracula");
  assert.equal(JSON.parse(stored!).mode, "dark");
});

test("custom with an empty customTheme loads Milagre Blue", () => {
  const settings = parsePhoneThemeSettings(JSON.stringify({ colorTheme: "custom", customThemeEnabled: true, customTheme: {} }));
  assert.equal(settings.colorTheme, "milagre-blue");
  assert.equal(settings.customTheme, null);
});

test("old saved settings parse to the appearance defaults and bad values fall back", () => {
  const old = parsePhoneThemeSettings(JSON.stringify({ colorTheme: "nord", mode: "dark" }));
  assert.equal(old.textSize, "default");
  assert.equal(old.codeSize, "default");
  assert.equal(old.diffColors, "red-green");
  assert.equal(old.motion, "normal");
  assert.equal(parsePhoneThemeSettings(JSON.stringify({ textSize: "huge" })).textSize, "default");
  assert.equal(parsePhoneThemeSettings(JSON.stringify({ codeSize: "larger" })).codeSize, "default");
  const set = parsePhoneThemeSettings(JSON.stringify({ textSize: "larger", codeSize: "small", diffColors: "blue-orange", motion: "off" }));
  assert.deepEqual([set.textSize, set.codeSize, set.diffColors, set.motion], ["larger", "small", "blue-orange", "off"]);
});
