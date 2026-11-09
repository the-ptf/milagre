export const CHAT_WIDTH_IDS = ["comfortable", "wide", "full", "custom"];
export const SIDEBAR_USAGE_IDS = ["expanded", "compact"];
export const PROVIDER_ICON_IDS = ["original", "simplified"];
export const DIFF_COLOR_IDS = ["red-green", "blue-orange", "purple-yellow"];
export const MOTION_IDS = ["normal", "fast", "off"];

export const DEFAULT_APPEARANCE = {
  uiFont: "system",
  monoFont: "system",
  sidebarSize: "default",
  chatSize: "default",
  codeSize: "default",
  chatWidth: "comfortable",
  chatWidthPx: 900,
  sidebarUsage: "expanded",
  providerIcons: "original",
  diffColors: "red-green",
  motion: "normal",
};

/** Sidebar rows grow by this many px per step from today's sizes. */
export const SIDEBAR_SIZES = [
  { id: "small", label: "Small", delta: -1 },
  { id: "default", label: "Default", delta: 0 },
  { id: "large", label: "Large", delta: 1 },
  { id: "larger", label: "Larger", delta: 2 },
];

export const CHAT_SIZES = [
  { id: "small", label: "Small", px: 12 },
  { id: "default", label: "Default", px: 13 },
  { id: "medium", label: "Medium", px: 14 },
  { id: "large", label: "Large", px: 15 },
  { id: "larger", label: "Larger", px: 17 },
];

export const CODE_SIZES = [
  { id: "small", label: "Small", px: 11 },
  { id: "default", label: "Default", px: 12 },
  { id: "medium", label: "Medium", px: 13 },
  { id: "large", label: "Large", px: 14 },
];

/** Max width of the chat column in px; null fills the pane. */
export const CHAT_WIDTHS = [
  { id: "comfortable", label: "Comfortable", px: 768 },
  { id: "wide", label: "Wide", px: 1024 },
  { id: "full", label: "Full", px: null },
  { id: "custom", label: "Custom", px: null },
];

export const SIDEBAR_USAGE_MODES = [
  { id: "expanded", label: "Expanded" },
  { id: "compact", label: "Compact" },
];

export const PROVIDER_ICON_STYLES = [
  { id: "original", label: "Original" },
  { id: "simplified", label: "Simplified" },
];

/** Red and green keeps each theme's own colors (null). */
export const DIFF_PAIRS = [
  { id: "red-green", label: "Red & green", light: null, dark: null },
  {
    id: "blue-orange",
    label: "Blue & orange",
    light: { add: "#1f6feb", remove: "#d9480f" },
    dark: { add: "#58a6ff", remove: "#ff8c42" },
  },
  {
    id: "purple-yellow",
    label: "Purple & yellow",
    light: { add: "#8250df", remove: "#b08800" },
    dark: { add: "#bc8cff", remove: "#e3b341" },
  },
];

/** Multiplier on panel animation durations. */
export const MOTION_SPEEDS = [
  { id: "normal", label: "Normal", scale: 1 },
  { id: "fast", label: "Fast", scale: 0.6 },
  { id: "off", label: "Off", scale: 0 },
];

const UI_FALLBACK = 'system-ui, -apple-system, "SF Pro Text", sans-serif';
const MONO_FALLBACK = 'ui-monospace, "SF Mono", Menlo, monospace';

function font(family, fallback, bundled) {
  return {
    id: family.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label: family,
    stack: `"${family}", ${fallback}`,
    bundled,
  };
}

/** System first; bundled fonts always load, the rest only when installed. */
export const UI_FONTS = [
  { id: "system", label: "System (SF Pro)", stack: UI_FALLBACK, bundled: true },
  font("Inter", UI_FALLBACK, true),
  font("Geist", UI_FALLBACK, true),
  font("IBM Plex Sans", UI_FALLBACK, false),
  font("Source Sans 3", UI_FALLBACK, false),
  font("Helvetica Neue", UI_FALLBACK, false),
  font("Avenir Next", UI_FALLBACK, false),
  font("Charter", UI_FALLBACK, false),
  font("Iowan Old Style", UI_FALLBACK, false),
  font("Atkinson Hyperlegible", UI_FALLBACK, false),
];

export const MONO_FONTS = [
  { id: "system", label: "System (SF Mono)", stack: MONO_FALLBACK, bundled: true },
  font("JetBrains Mono", MONO_FALLBACK, true),
  font("Fira Code", MONO_FALLBACK, false),
  font("Geist Mono", MONO_FALLBACK, true),
  font("Cascadia Code", MONO_FALLBACK, false),
  font("IBM Plex Mono", MONO_FALLBACK, false),
  font("Source Code Pro", MONO_FALLBACK, false),
  font("Menlo", MONO_FALLBACK, false),
  font("Monaco", MONO_FALLBACK, false),
  font("Berkeley Mono", MONO_FALLBACK, false),
  font("Iosevka", MONO_FALLBACK, false),
];

export const PHONE_TEXT_SIZES = [
  { id: "small", label: "Small", px: 14 },
  { id: "default", label: "Default", px: 15 },
  { id: "large", label: "Large", px: 17 },
  { id: "larger", label: "Larger", px: 19 },
];

export const PHONE_CODE_SIZES = [
  { id: "small", label: "Small", px: 11 },
  { id: "default", label: "Default", px: 12 },
  { id: "large", label: "Large", px: 14 },
];

const VALID = {
  uiFont: null,
  monoFont: null,
  sidebarSize: SIDEBAR_SIZES.map((step) => step.id),
  chatSize: CHAT_SIZES.map((step) => step.id),
  codeSize: CODE_SIZES.map((step) => step.id),
  chatWidth: CHAT_WIDTH_IDS,
  sidebarUsage: SIDEBAR_USAGE_IDS,
  providerIcons: PROVIDER_ICON_IDS,
  diffColors: DIFF_COLOR_IDS,
  motion: MOTION_IDS,
};

export const CHAT_WIDTH_PX_MIN = 600;
export const CHAT_WIDTH_PX_MAX = 2400;

/** The custom chat width in px, clamped to 600..2400; anything that is not a finite number is 900. */
export function clampChatWidth(px) {
  const n = typeof px === "string" && px.trim() !== "" ? Number(px) : px;
  if (typeof n !== "number" || !Number.isFinite(n)) return 900;
  return Math.min(CHAT_WIDTH_PX_MAX, Math.max(CHAT_WIDTH_PX_MIN, Math.round(n)));
}

/** Unknown input or bad fields fall back to the defaults; good fields are kept. */
export function parseAppearance(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const result = { ...DEFAULT_APPEARANCE };
  for (const key of Object.keys(VALID)) {
    const value = source[key];
    if (typeof value !== "string" || value === "") continue;
    const allowed = VALID[key];
    if (allowed === null || allowed.includes(value)) result[key] = value;
  }
  result.chatWidthPx = clampChatWidth(source.chatWidthPx);
  return result;
}

/** The CSS font-family stack for a font id; system when unknown, or neither bundled nor installed. */
export function fontStack(list, id, installed) {
  const entry = list.find((candidate) => candidate.id === id);
  if (!entry) return list[0].stack;
  return entry.bundled || installed(entry.label) ? entry.stack : list[0].stack;
}
