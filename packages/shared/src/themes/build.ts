import { mix, onColor, withAlpha } from "./color.ts";
import type { Ansi, Scheme, ThemePalette, ThemeSource } from "./types.ts";
import type { SyntaxKind } from "../file-syntax.mjs";

/** A tint of `color` on `page`: solid in light (so it stacks predictably), translucent in dark (so it sits on any surface). */
const tint = (page: string, color: string, scheme: Scheme, light: number, dark: number) =>
  scheme === "dark" ? withAlpha(color, dark) : mix(page, color, light);

export function buildPalette(source: ThemeSource, scheme: Scheme): ThemePalette {
  const { page, surface, ink, accent, green, orange, red } = source;
  const dark = scheme === "dark";
  const toward = (t: number) => mix(surface, ink, t);
  const derived: ThemePalette = {
    page,
    surface,
    ink,
    accent,
    green,
    orange,
    red,
    purple: source.purple,
    ansi: source.ansi,
    syntax: source.syntax,
    canvas: mix(page, ink, dark ? 0.025 : 0.03),
    inset: mix(page, surface, 0.5),
    hover: toward(dark ? 0.05 : 0.035),
    hover2: toward(dark ? 0.09 : 0.07),
    field: toward(dark ? 0.06 : 0.04),
    ink2: mix(ink, page, 0.36),
    ink3: mix(ink, page, 0.56),
    onAccent: onColor(accent, page),
    line: toward(dark ? 0.09 : 0.07),
    lineStrong: toward(dark ? 0.14 : 0.12),
    accentInk: dark ? mix(accent, ink, 0.35) : mix(accent, "#000000", 0.12),
    accentTint: tint(page, accent, scheme, 0.08, 0.16),
    greenTint: tint(page, green, scheme, 0.08, 0.14),
    orangeTint: tint(page, orange, scheme, 0.08, 0.14),
    redTint: tint(page, red, scheme, 0.08, 0.14),
    diffAdd: tint(page, green, scheme, 0.12, 0.12),
    diffAddWord: tint(page, green, scheme, 0.3, 0.3),
    diffRemove: tint(page, red, scheme, 0.1, 0.12),
    diffRemoveWord: tint(page, red, scheme, 0.26, 0.3),
    cursor: ink,
    selection: withAlpha(accent, 0.3),
  };
  const given = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
  return { ...derived, ...given } as ThemePalette;
}

export function ansi(c: {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}): Ansi {
  return [
    c.black,
    c.red,
    c.green,
    c.yellow,
    c.blue,
    c.magenta,
    c.cyan,
    c.white,
    c.brightBlack ?? mix(c.black, c.white, 0.35),
    c.brightRed ?? c.red,
    c.brightGreen ?? c.green,
    c.brightYellow ?? c.yellow,
    c.brightBlue ?? c.blue,
    c.brightMagenta ?? c.magenta,
    c.brightCyan ?? c.cyan,
    c.brightWhite ?? c.white,
  ] as const;
}

export function syntax(c: {
  plain: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  tag?: string;
  property?: string;
  operator?: string;
  punctuation?: string;
}): Record<SyntaxKind, string> {
  return { ...c, tag: c.tag ?? c.keyword, property: c.property ?? c.type, operator: c.operator ?? c.keyword, punctuation: c.punctuation ?? c.plain };
}
