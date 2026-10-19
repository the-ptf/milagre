import { DIFF_COLOR_IDS, MOTION_IDS, PHONE_CODE_SIZES, PHONE_TEXT_SIZES, type DiffColors, type MotionSpeed } from "@milagre/shared/appearance";
import { parseCustomTheme, resolveThemeSettings, type CustomTheme, type ThemeChoice } from "@milagre/shared/themes";

// The phone's color theme, read once and shared by every screen. No React Native imports, so it runs under node:test.
export type PhoneThemeSettings = {
  mode: "system" | "light" | "dark";
  colorTheme: ThemeChoice;
  customThemeEnabled: boolean;
  customTheme: CustomTheme | null;
  textSize: PhoneTextSize;
  codeSize: PhoneCodeSize;
  diffColors: DiffColors;
  motion: MotionSpeed;
};

export type PhoneTextSize = "small" | "default" | "large" | "larger";
export type PhoneCodeSize = "small" | "default" | "large";
const TEXT_SIZES = PHONE_TEXT_SIZES.map((size) => size.id) as PhoneTextSize[];
const CODE_SIZES = PHONE_CODE_SIZES.map((size) => size.id) as PhoneCodeSize[];

export const DEFAULT_PHONE_THEME: PhoneThemeSettings = {
  mode: "system",
  colorTheme: "milagre-blue",
  customThemeEnabled: false,
  customTheme: null,
  textSize: "default",
  codeSize: "default",
  diffColors: "red-green",
  motion: "normal",
};

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return list.includes(value as T) ? (value as T) : fallback;
}

const MODES: readonly PhoneThemeSettings["mode"][] = ["system", "light", "dark"];

export function parsePhoneThemeSettings(raw: string | null): PhoneThemeSettings {
  if (!raw) return DEFAULT_PHONE_THEME;
  let saved: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_PHONE_THEME;
    saved = parsed as Record<string, unknown>;
  } catch {
    return DEFAULT_PHONE_THEME;
  }
  const customTheme = parseCustomTheme(saved.customTheme);
  const customThemeEnabled = typeof saved.customThemeEnabled === "boolean" ? saved.customThemeEnabled : false;
  return {
    mode: MODES.includes(saved.mode as PhoneThemeSettings["mode"]) ? (saved.mode as PhoneThemeSettings["mode"]) : "system",
    colorTheme: resolveThemeSettings({ colorTheme: saved.colorTheme, customThemeEnabled, customTheme }),
    customThemeEnabled,
    customTheme,
    textSize: oneOf(TEXT_SIZES, saved.textSize, "default"),
    codeSize: oneOf(CODE_SIZES, saved.codeSize, "default"),
    diffColors: oneOf(DIFF_COLOR_IDS, saved.diffColors, "red-green"),
    motion: oneOf(MOTION_IDS, saved.motion, "normal"),
  };
}

type ThemeIo = { read(): Promise<string | null>; save(raw: string): Promise<void> };

let state = DEFAULT_PHONE_THEME;
let io: ThemeIo | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export const getThemeSettings = () => state;

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setThemeSettings(patch: Partial<PhoneThemeSettings>) {
  state = { ...state, ...patch };
  notify();
  if (io) void io.save(JSON.stringify(state)).catch(() => {});
}

export async function initThemeStore(next: ThemeIo) {
  io = next;
  state = parsePhoneThemeSettings(await next.read().catch(() => null));
  notify();
}
