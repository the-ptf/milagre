import { ansi, syntax } from "./build.ts";
import { contrastRatio, fromOklch, hexToOklch, mix } from "./color.ts";
import { getTheme } from "./registry.ts";
import type { CustomTheme, ThemeId, ThemeSeeds, ThemeSource } from "./types.ts";

function status(hue: number, chroma: number, background: string) {
  const bgL = hexToOklch(background).l;
  const lighter = bgL < 0.5;
  let l = lighter ? Math.max(0.68, bgL + 0.45) : Math.min(0.58, bgL - 0.38);
  let color = fromOklch(l, chroma, hue);
  for (let i = 0; i < 30 && contrastRatio(color, background) < 3; i++) {
    l = Math.min(1, Math.max(0, l + (lighter ? 0.02 : -0.02)));
    color = fromOklch(l, chroma, hue);
  }
  return color;
}

export function customSource({ background, text, accent }: ThemeSeeds): ThemeSource {
  const surface = hexToOklch(background).l < 0.5 ? mix(background, text, 0.06) : mix(background, "#ffffff", 0.6);
  const s = (hue: number, chroma = 0.16) => status(hue, chroma, background);
  const [red, green, yellow, blue, magenta, cyan, orange] = [s(25), s(150), s(85, 0.14), s(255), s(320), s(200, 0.12), s(55)] as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    page: background,
    surface,
    ink: text,
    accent,
    green,
    orange,
    red,
    purple: magenta,
    ansi: ansi({
      black: mix(background, text, 0.25),
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white: mix(text, background, 0.2),
      brightWhite: text,
    }),
    syntax: syntax({ plain: text, comment: mix(text, background, 0.5), keyword: magenta, string: green, number: orange, function: blue, type: yellow }),
  };
}

const SEED = /^#[0-9a-f]{6}$/i;
const isSeed = (v: unknown): v is string => typeof v === "string" && SEED.test(v);
const isSeeds = (v: unknown): v is ThemeSeeds =>
  !!v && typeof v === "object" && isSeed((v as ThemeSeeds).background) && isSeed((v as ThemeSeeds).text) && isSeed((v as ThemeSeeds).accent);

/** Accepts an object or a JSON string; returns normalized (lowercase) seeds or null. */
export function parseCustomTheme(value: unknown): CustomTheme | null {
  let data = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { light, dark } = data as Partial<CustomTheme>;
  if (!isSeeds(light) || !isSeeds(dark)) return null;
  const pick = (s: ThemeSeeds) => ({ background: s.background.toLowerCase(), text: s.text.toLowerCase(), accent: s.accent.toLowerCase() });
  return { light: pick(light), dark: pick(dark) };
}

export const serializeCustomTheme = (theme: CustomTheme) => JSON.stringify(theme, null, 2);

export function seedsFrom(id: ThemeId): CustomTheme {
  const theme = getTheme(id)!;
  const seeds = (src: ThemeSource) => ({ background: src.page, text: src.ink, accent: src.accent });
  return { light: seeds(theme.light), dark: seeds(theme.dark) };
}

export const customContrast = (s: ThemeSeeds) => ({ text: contrastRatio(s.text, s.background), accent: contrastRatio(s.accent, s.background) });
