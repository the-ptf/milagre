import { useSyncExternalStore } from "react";
import { Appearance, Platform, StyleSheet, useColorScheme } from "react-native";
import { DIFF_PAIRS, MOTION_SPEEDS, PHONE_CODE_SIZES, PHONE_TEXT_SIZES } from "@milagre/shared/appearance";
import { mix, onColor, resolvePalette, ULTRACODE_PURPLE, withAlpha, type ThemePalette } from "@milagre/shared/themes";
import { readThemeSettings, saveThemeSettings } from "./hosts-native";
import { getThemeSettings, initThemeStore, setThemeSettings, subscribeTheme, type PhoneThemeSettings } from "./theme-store";

export const fonts = { mono: Platform.OS === "ios" ? "Menlo" : "monospace" };

export type Palette = ThemePalette & {
  bg: string;
  panel: string;
  text: string;
  muted: string;
  error: string;
  onInk: string;
  idleDot: string;
  scrim: string;
  backdrop: string;
  purpleInk: string;
  purpleTint: string;
  onRed: string;
  onRedInk: string;
  paper: string;
  shadowCard: string;
  shadowRaised: string;
  shadowOverlay: string;
  media: string;
  onMedia: string;
  onMedia2: string;
  onMediaTint: string;
  add: string;
  remove: string;
};

function applyMode(mode: PhoneThemeSettings["mode"]) {
  Appearance.setColorScheme(mode === "system" ? "unspecified" : mode);
}
void initThemeStore({ read: readThemeSettings, save: saveThemeSettings }).then(() => applyMode(getThemeSettings().mode));

const MEDIA = { media: "#000000", onMedia: "#ffffff", onMedia2: "#ffffffcc", onMediaTint: "#ffffff26", paper: "#ffffff" };
const ELEVATION = {
  light: { card: "0 1px 3px #0000000f", raised: "0 4px 20px #0000000f", overlay: "0 8px 28px #00000017" },
  dark: { card: "0 1px 3px #00000040", raised: "0 4px 20px #00000059", overlay: "0 8px 28px #00000080" },
};
function extend(p: ThemePalette, scheme: "light" | "dark"): Palette {
  const ring = `0 0 0 ${StyleSheet.hairlineWidth}px ${p.line}`;
  const shadow = ELEVATION[scheme];
  return {
    ...p,
    ...ULTRACODE_PURPLE[scheme],
    bg: p.page,
    panel: p.surface,
    text: p.ink,
    muted: p.ink2,
    error: p.redInk,
    onInk: p.surface,
    onRed: onColor(p.red, p.page),
    onRedInk: p.onRed,
    shadowCard: `${ring}, ${shadow.card}`,
    shadowRaised: `${ring}, ${shadow.raised}`,
    shadowOverlay: `${ring}, ${shadow.overlay}`,
    ...MEDIA,
    idleDot: p.ink4,
    scrim: scheme === "dark" ? "#00000066" : "#00000033",
    backdrop: scheme === "dark" ? "#00000066" : "#00000033",
    add: p.green,
    remove: p.red,
  };
}

export function inkFor(colors: Palette, tone: "accent" | "green" | "orange" | "red" | "purple" | "ink" | "ink2" | "ink3"): string {
  return tone === "ink" || tone === "ink2" || tone === "ink3" ? colors[tone] : colors[`${tone}Ink`];
}

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

function appearanceScales(settings: Pick<PhoneThemeSettings, "textSize" | "codeSize" | "motion">) {
  const text = PHONE_TEXT_SIZES.find((entry) => entry.id === settings.textSize)?.px ?? 15;
  const code = PHONE_CODE_SIZES.find((entry) => entry.id === settings.codeSize)?.px ?? 12;
  const motionScale = MOTION_SPEEDS.find((entry) => entry.id === settings.motion)?.scale ?? 1;
  return { typeScale: text / 15, textPx: text, codeSize: code, motionScale };
}

export const getMotionScale = () => appearanceScales(getThemeSettings()).motionScale;

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
