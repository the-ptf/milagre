import type { SyntaxKind } from "../file-syntax.mjs";

export type Scheme = "light" | "dark";
export type ThemeId =
  | "milagre-blue"
  | "gray"
  | "black"
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
  hover: string;
  hover2: string;
  field: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  onAccent: string;
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
export type ThemeSource = Pick<ThemePalette, "page" | "surface" | "ink" | "accent" | "green" | "orange" | "red" | "purple" | "ansi" | "syntax"> &
  Partial<ThemePalette>;
export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  group: ThemeGroup;
  lightName: string;
  darkName: string;
  light: ThemeSource;
  dark: ThemeSource;
}
export type ThemeSeeds = { background: string; text: string; accent: string };
export type CustomTheme = { light: ThemeSeeds; dark: ThemeSeeds };
