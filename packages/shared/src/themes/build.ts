import { contrastRatio, mix, onColor, over, readableOn, withAlpha } from "./color.ts";
import type { Ansi, Scheme, ThemePalette, ThemeSource } from "./types.ts";
import type { SyntaxKind } from "../file-syntax.mjs";

/** A tint of `color` on `page`: solid in light (so it stacks predictably), translucent in dark (so it sits on any surface). */
const tint = (page: string, color: string, scheme: Scheme, light: number, dark: number) =>
  scheme === "dark" ? withAlpha(color, dark) : mix(page, color, light);

/** Tokens solved from the rest of the palette at the end, so a theme never sets text below 4.5:1. */
type Solved = "ink4" | "greenInk" | "orangeInk" | "redInk" | "onGreen" | "onOrange" | "onRed";

export function buildPalette(source: ThemeSource, scheme: Scheme): ThemePalette {
  const { page, surface, ink, accent, green, orange, red } = source;
  const dark = scheme === "dark";
  const toward = (t: number) => mix(surface, ink, t);
  const derived: Omit<ThemePalette, Solved> = {
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
    // Translucent ink, so a hover darkens whatever it sits on: page, card or field.
    hover: withAlpha(ink, dark ? 0.05 : 0.04),
    hover2: withAlpha(ink, dark ? 0.09 : 0.08),
    field: toward(dark ? 0.06 : 0.04),
    ink2: mix(ink, page, 0.25),
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
  const palette = { ...derived, ...given } as Omit<ThemePalette, Solved>;
  // ink2, ink3 and the status colors carry metadata, descriptions and counts at 10–13px, so as text they need 4.5:1
  // wherever they sit: the page, cards, fields, the hover-2 highlight (on page or card) and, for a status, its own
  // tint. A theme's own ink3 stays as ink4, for icons at rest, dots and disabled controls.
  const { page: pg, surface: sf } = palette;
  const behind = (fill: string) => [over(fill, pg), over(fill, sf)];
  const text = [pg, sf, ...behind(palette.field), ...behind(palette.hover2)];
  const onTint = (tint: string) => [pg, sf, ...behind(tint)];
  const worst = (color: string) => Math.min(...text.map((bg) => contrastRatio(color, bg)));
  const ink2 = readableOn(palette.ink2, palette.ink, text);
  // Where ink2 is itself close to 4.5:1, a readable ink3 would pass it; the levels then share ink2.
  const ink3 = readableOn(palette.ink3, palette.ink, text);
  const greenInk = readableOn(palette.green, palette.ink, onTint(palette.greenTint));
  const orangeInk = readableOn(palette.orange, palette.ink, onTint(palette.orangeTint));
  const redInk = readableOn(palette.red, palette.ink, onTint(palette.redTint));
  return {
    ...palette,
    ink2,
    ink3: worst(ink3) > worst(ink2) ? ink2 : ink3,
    ink4: palette.ink3,
    accentInk: readableOn(palette.accentInk, palette.ink, onTint(palette.accentTint)),
    greenInk,
    orangeInk,
    redInk,
    // Labels on a status fill that carries a count or a word: the fill is the -ink color (bg-red-ink text-on-red).
    onGreen: onColor(greenInk, pg),
    onOrange: onColor(orangeInk, pg),
    onRed: onColor(redInk, pg),
  };
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
