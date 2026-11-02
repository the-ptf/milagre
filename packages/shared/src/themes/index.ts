import { buildPalette } from "./build.ts";
import { customSource } from "./custom.ts";
import { byId, DEFAULT_THEME_ID, getTheme } from "./registry.ts";
import type { CustomTheme, Scheme, ThemeChoice, ThemePalette } from "./types.ts";
export * from "./types.ts";
export * from "./color.ts";
export { buildPalette } from "./build.ts";
export * from "./custom.ts";
export { DEFAULT_THEME_ID, getTheme, themes } from "./registry.ts";

/** Ultracode's purple, a brand color that themes don't override; merged PRs use it too. `purple` for icons and fills,
 * `purpleInk` for text, `purpleTint` behind it. The phone theme reads it; desktop styles.css mirrors it. */
export const ULTRACODE_PURPLE = {
  light: { purple: "#ad46ff", purpleInk: "#8e2bdc", purpleTint: "#f6edff" },
  dark: { purple: "#ad46ff", purpleInk: "#d0a3ff", purpleTint: "#ad46ff2e" },
} as const;

const cache = new Map<string, ThemePalette>();
export const isThemeChoice = (value: unknown): value is ThemeChoice => value === "custom" || (typeof value === "string" && byId.has(value));

/** The palette to show. `custom` without a custom theme, or an unknown id, falls back to Milagre Blue. */
export function resolvePalette(choice: string, scheme: Scheme, custom?: CustomTheme | null): ThemePalette {
  if (choice === "custom" && custom) {
    const { background, text, accent } = custom[scheme];
    const key = `custom:${scheme}:${background}|${text}|${accent}`;
    let palette = cache.get(key);
    if (!palette) {
      if (cache.size > 64) for (const k of cache.keys()) if (k.startsWith("custom:")) cache.delete(k);
      cache.set(key, (palette = buildPalette(customSource(custom[scheme]), scheme)));
    }
    return palette;
  }
  const theme = getTheme(choice) ?? byId.get(DEFAULT_THEME_ID)!;
  const key = `${theme.id}:${scheme}`;
  let palette = cache.get(key);
  if (!palette) cache.set(key, (palette = buildPalette(theme[scheme], scheme)));
  return palette;
}

/** Settings as loaded from storage → the choice actually in effect. Custom needs the Experimental switch on and saved seeds. */
export function resolveThemeSettings(saved: { colorTheme?: unknown; customThemeEnabled?: unknown; customTheme?: CustomTheme | null }): ThemeChoice {
  const { colorTheme } = saved;
  if (colorTheme === "custom") return saved.customThemeEnabled === true && saved.customTheme ? "custom" : DEFAULT_THEME_ID;
  return isThemeChoice(colorTheme) ? colorTheme : DEFAULT_THEME_ID;
}

/** Swatch colors for a picker tile: the dark palette's page and accent. */
export function themeSwatch(id: ThemeChoice, custom?: CustomTheme | null) {
  const { page, accent } = resolvePalette(id, "dark", custom);
  return { page, accent };
}
