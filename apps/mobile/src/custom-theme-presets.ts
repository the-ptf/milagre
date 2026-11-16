import { resolvePalette, type Scheme, type ThemeSeeds } from "@milagre/shared/themes";

const PRESET_THEMES = ["milagre-blue", "catppuccin-mocha", "dracula", "nord", "rose-pine", "gruvbox", "tokyo-night", "one-dark"];

export function presets(scheme: Scheme): Record<keyof ThemeSeeds, string[]> {
  const palettes = PRESET_THEMES.map((id) => resolvePalette(id, scheme));
  return { background: palettes.map((p) => p.page), text: palettes.map((p) => p.ink), accent: palettes.map((p) => p.accent) };
}
