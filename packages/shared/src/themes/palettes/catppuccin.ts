import { ansi, syntax } from "../build.ts";
import type { ThemeDefinition, ThemeSource } from "../types.ts";

type Flavor = Record<
  | "base"
  | "mantle"
  | "surface0"
  | "surface1"
  | "surface2"
  | "overlay1"
  | "overlay2"
  | "subtext0"
  | "subtext1"
  | "text"
  | "mauve"
  | "red"
  | "peach"
  | "yellow"
  | "green"
  | "teal"
  | "sky"
  | "blue"
  | "lavender"
  | "pink",
  string
>;

const latte: Flavor = {
  base: "#eff1f5",
  mantle: "#e6e9ef",
  surface0: "#ccd0da",
  surface1: "#bcc0cc",
  surface2: "#acb0be",
  overlay1: "#8c8fa1",
  overlay2: "#7c7f93",
  subtext0: "#6c6f85",
  subtext1: "#5c5f77",
  text: "#4c4f69",
  mauve: "#8839ef",
  red: "#d20f39",
  peach: "#fe640b",
  yellow: "#df8e1d",
  green: "#40a02b",
  teal: "#179299",
  sky: "#04a5e5",
  blue: "#1e66f5",
  lavender: "#7287fd",
  pink: "#ea76cb",
};
const frappe: Flavor = {
  base: "#303446",
  mantle: "#292c3c",
  surface0: "#414559",
  surface1: "#51576d",
  surface2: "#626880",
  overlay1: "#838ba7",
  overlay2: "#949cbb",
  subtext0: "#a5adce",
  subtext1: "#b5bfe2",
  text: "#c6d0f5",
  mauve: "#ca9ee6",
  red: "#e78284",
  peach: "#ef9f76",
  yellow: "#e5c890",
  green: "#a6d189",
  teal: "#81c8be",
  sky: "#99d1db",
  blue: "#8caaee",
  lavender: "#babbf1",
  pink: "#f4b8e4",
};
const macchiato: Flavor = {
  base: "#24273a",
  mantle: "#1e2030",
  surface0: "#363a4f",
  surface1: "#494d64",
  surface2: "#5b6078",
  overlay1: "#8087a2",
  overlay2: "#939ab7",
  subtext0: "#a5adcb",
  subtext1: "#b8c0e0",
  text: "#cad3f5",
  mauve: "#c6a0f6",
  red: "#ed8796",
  peach: "#f5a97f",
  yellow: "#eed49f",
  green: "#a6da95",
  teal: "#8bd5ca",
  sky: "#91d7e3",
  blue: "#8aadf4",
  lavender: "#b7bdf8",
  pink: "#f5bde6",
};
const mocha: Flavor = {
  base: "#1e1e2e",
  mantle: "#181825",
  surface0: "#313244",
  surface1: "#45475a",
  surface2: "#585b70",
  overlay1: "#7f849c",
  overlay2: "#9399b2",
  subtext0: "#a6adc8",
  subtext1: "#bac2de",
  text: "#cdd6f4",
  mauve: "#cba6f7",
  red: "#f38ba8",
  peach: "#fab387",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  sky: "#89dceb",
  blue: "#89b4fa",
  lavender: "#b4befe",
  pink: "#f5c2e7",
};

function source(f: Flavor, light: boolean): ThemeSource {
  return {
    page: f.base,
    canvas: f.mantle,
    surface: light ? "#ffffff" : f.surface0,
    ink: f.text,
    ink2: light ? f.subtext1 : f.subtext0,
    ink3: f.overlay1,
    line: light ? f.surface0 : f.surface1,
    accent: f.mauve,
    green: f.green,
    red: f.red,
    orange: f.peach,
    purple: f.mauve,
    ansi: ansi({
      black: f.surface1,
      red: f.red,
      green: f.green,
      yellow: f.yellow,
      blue: f.blue,
      magenta: f.pink,
      cyan: f.teal,
      white: f.subtext1,
      brightBlack: f.surface2,
      brightWhite: f.subtext0,
    }),
    syntax: syntax({
      plain: f.text,
      comment: f.overlay2,
      keyword: f.mauve,
      string: f.green,
      number: f.peach,
      function: f.blue,
      type: f.yellow,
      tag: f.blue,
      property: f.lavender,
      operator: f.sky,
      punctuation: f.overlay2,
    }),
  };
}

const flavor = (id: "catppuccin-mocha" | "catppuccin-macchiato" | "catppuccin-frappe", name: string, dark: Flavor): ThemeDefinition => ({
  id,
  name,
  group: "Catppuccin",
  lightName: "Latte",
  darkName: name,
  light: source(latte, true),
  dark: source(dark, false),
});

export const catppuccinThemes: readonly ThemeDefinition[] = [
  flavor("catppuccin-mocha", "Mocha", mocha),
  flavor("catppuccin-macchiato", "Macchiato", macchiato),
  flavor("catppuccin-frappe", "Frappé", frappe),
];
