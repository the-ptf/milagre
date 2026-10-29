import { useSyncExternalStore } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";
import { DIFF_PAIRS, MOTION_SPEEDS, PHONE_CODE_SIZES, PHONE_TEXT_SIZES } from "@milagre/shared/appearance";
import { mix, onColor, resolvePalette, withAlpha, type ThemePalette } from "@milagre/shared/themes";
import { readThemeSettings, saveThemeSettings } from "./hosts-native";
import { getThemeSettings, initThemeStore, setThemeSettings, subscribeTheme, type PhoneThemeSettings } from "./theme-store";

export const fonts = { mono: Platform.OS === "ios" ? "Menlo" : "monospace" };

/** The themed palette plus the phone's short names. */
export type Palette = ThemePalette & {
  bg: string;
  panel: string;
  text: string;
  muted: string;
  error: string;
  onInk: string;
  idleDot: string;
  backdrop: string;
  purpleInk: string;
  purpleTint: string;
  /** Additions and deletions: the theme's green and red unless Diff colors picks another pair. */
  add: string;
  remove: string;
};

function applyMode(mode: PhoneThemeSettings["mode"]) {
  Appearance.setColorScheme(mode === "system" ? "unspecified" : mode);
}
void initThemeStore({ read: readThemeSettings, save: saveThemeSettings }).then(() => applyMode(getThemeSettings().mode));

// Ultracode's purple is a brand color, the same in every theme (desktop keeps --purple out of the theme sheet too).
const ULTRACODE = {
  light: { purple: "#ad46ff", purpleInk: "#8e2bdc", purpleTint: "#f6edff" },
  dark: { purple: "#ad46ff", purpleInk: "#d0a3ff", purpleTint: "#ad46ff2e" },
};
function extend(p: ThemePalette, scheme: "light" | "dark"): Palette {
  return {
    ...p,
    ...ULTRACODE[scheme],
    bg: p.page,
    panel: p.surface,
    text: p.ink,
    muted: p.ink2,
    error: p.redInk,
    onInk: onColor(p.ink, p.page),
    idleDot: withAlpha(p.ink4, 0.4),
    backdrop: scheme === "dark" ? "#00000066" : "#00000033",
    add: p.green,
    remove: p.red,
  };
}

// Diff colors: swap the add/remove colors and the diff row tints; the theme's own green and red stay for status and errors.
function withDiffColors(p: Palette, diffColors: PhoneThemeSettings["diffColors"], scheme: "light" | "dark"): Palette {
  const pair = DIFF_PAIRS.find((entry) => entry.id === diffColors)?.[scheme];
  if (!pair) return p;
  const tint = (color: string, light: number, dark: number) => (scheme === "dark" ? withAlpha(color, dark) : mix(p.page, color, light));
  return {
    ...p,
    add: pair.add,
    remove: pair.remove,
    diffAdd: tint(pair.add, 0.12, 0.12),
    diffAddWord: tint(pair.add, 0.3, 0.3),
    diffRemove: tint(pair.remove, 0.1, 0.12),
    diffRemoveWord: tint(pair.remove, 0.26, 0.3),
  };
}

function setTheme(patch: Partial<PhoneThemeSettings>) {
  setThemeSettings(patch);
  if (patch.mode) applyMode(patch.mode);
}

// One palette object per theme, shared by every component, so per-palette style caches hit across the app.
const paletteCache = new Map<string, Palette>();
function paletteFor(settings: PhoneThemeSettings, scheme: "light" | "dark"): Palette {
  const key = `${settings.colorTheme}|${settings.diffColors}|${scheme}|${JSON.stringify(settings.customTheme ?? null)}`;
  let palette = paletteCache.get(key);
  if (!palette) {
    if (paletteCache.size > 24) paletteCache.clear();
    palette = withDiffColors(extend(resolvePalette(settings.colorTheme, scheme, settings.customTheme), scheme), settings.diffColors, scheme);
    paletteCache.set(key, palette);
  }
  return palette;
}

export function useTheme() {
  const settings = useSyncExternalStore(subscribeTheme, getThemeSettings);
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const palette = paletteFor(settings, scheme);
  const scale = appearanceScales(settings);
  return { colors: palette, scheme, settings, set: setTheme, diff: { add: palette.add, remove: palette.remove }, ...scale } as const;
}

/** Text size in px for chat text (15 by default), code size in px (12), and the motion multiplier (1, 0.6, 0). */
function appearanceScales(settings: Pick<PhoneThemeSettings, "textSize" | "codeSize" | "motion">) {
  const text = PHONE_TEXT_SIZES.find((entry) => entry.id === settings.textSize)?.px ?? 15;
  const code = PHONE_CODE_SIZES.find((entry) => entry.id === settings.codeSize)?.px ?? 12;
  const motionScale = MOTION_SPEEDS.find((entry) => entry.id === settings.motion)?.scale ?? 1;
  return { typeScale: text / 15, textPx: text, codeSize: code, motionScale };
}

/** The motion multiplier for code outside React (worklet setup, module-level animations). */
export const getMotionScale = () => appearanceScales(getThemeSettings()).motionScale;

/** A hook for a style sheet that depends on the palette: built once per palette, shared by every component that calls it. */
export function createStylesHook<T>(make: (colors: Palette) => T): () => T {
  const cache = new WeakMap<Palette, T>();
  return () => {
    const { colors } = useTheme();
    let styles = cache.get(colors);
    if (!styles) {
      styles = make(colors);
      cache.set(colors, styles);
    }
    return styles;
  };
}
