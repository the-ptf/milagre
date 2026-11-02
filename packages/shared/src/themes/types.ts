import type { SyntaxKind } from "../file-syntax.mjs";

export type Scheme = "light" | "dark";
export type ThemeId =
  | "milagre-blue"
  | "gray"
  | "catppuccin-mocha"
  | "catppuccin-macchiato"
  | "catppuccin-frappe"
  | "tokyo-night"
  | "dracula"
  | "nord"
  | "rose-pine"
  | "gruvbox"
  | "solarized"
  | "one-dark";
export type ThemeChoice = ThemeId | "custom";
export type ThemeGroup = "Milagre" | "Catppuccin" | "Popular";
/** 16 ANSI colors in xterm order: black, red, green, yellow, blue, magenta, cyan, white, then the bright eight. */
export type Ansi = readonly [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];
export interface ThemePalette {
  page: string;
  canvas: string;
  surface: string;
  inset: string;
  /** Translucent ink (4% light, 5% dark): pointer hover on anything, page, card or field. */
  hover: string;
  /** Translucent ink (8% light, 9% dark): the open or selected row, a pressed toggle, the menu highlight. */
  hover2: string;
  field: string;
  ink: string;
  /** Secondary text: values, descriptions, chip labels. 4.5:1 on page, surface, field and hover-2. */
  ink2: string;
  /** Tertiary text: metadata, descriptions, placeholders. 4.5:1 on page, surface, field and hover-2. */
  ink3: string;
  /** The theme's own faint ink, for icons at rest, dots and disabled controls; not for text. */
  ink4: string;
  /** Label on an accent or accent-ink fill. */
  onAccent: string;
  /** Labels on the status -ink fills (a count on a pin, the danger button): white or the page, whichever reads. */
  onGreen: string;
  onOrange: string;
  onRed: string;
  line: string;
  lineStrong: string;
  accent: string;
  accentInk: string;
  accentTint: string;
  green: string;
  greenTint: string;
  orange: string;
  orangeTint: string;
  red: string;
  redTint: string;
  /** The status colors as text: 4.5:1 on page, surface and their own tint. The plain ones stay for fills, dots and icons. */
  greenInk: string;
  orangeInk: string;
  redInk: string;
  purple: string;
  diffAdd: string;
  diffAddWord: string;
  diffRemove: string;
  diffRemoveWord: string;
  ansi: Ansi;
  cursor: string;
  selection: string;
  syntax: Record<SyntaxKind, string>;
}
/** What a theme author writes: the official colors. Everything else is derived by `buildPalette`; any palette key may be given to override. */
export type ThemeSource = Pick<ThemePalette, "page" | "surface" | "ink" | "accent" | "green" | "orange" | "red" | "purple" | "ansi" | "syntax"> &
  Partial<ThemePalette>;
export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  group: ThemeGroup;
  /** The paired theme's name, shown under the tile ("Light: Latte"). */
  lightName: string;
  darkName: string;
  light: ThemeSource;
  dark: ThemeSource;
}
export type ThemeSeeds = { background: string; text: string; accent: string };
export type CustomTheme = { light: ThemeSeeds; dark: ThemeSeeds };
