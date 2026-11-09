export type SizeStep = "small" | "default" | "medium" | "large" | "larger";
export type ChatWidth = "comfortable" | "wide" | "full" | "custom";
export type SidebarUsageMode = "expanded" | "compact";
export type ProviderIconStyle = "original" | "simplified";
export type DiffColors = "red-green" | "blue-orange" | "purple-yellow";
export type MotionSpeed = "normal" | "fast" | "off";

export type Appearance = {
  uiFont: string;
  monoFont: string;
  sidebarSize: SizeStep;
  chatSize: SizeStep;
  codeSize: SizeStep;
  chatWidth: ChatWidth;
  chatWidthPx: number;
  sidebarUsage: SidebarUsageMode;
  providerIcons: ProviderIconStyle;
  diffColors: DiffColors;
  motion: MotionSpeed;
};

export type FontOption = { id: string; label: string; stack: string; bundled: boolean };
export type DiffPair = {
  id: DiffColors;
  label: string;
  light: { add: string; remove: string } | null;
  dark: { add: string; remove: string } | null;
};

export const CHAT_WIDTH_IDS: readonly ChatWidth[];
export const SIDEBAR_USAGE_IDS: readonly SidebarUsageMode[];
export const PROVIDER_ICON_IDS: readonly ProviderIconStyle[];
export const DIFF_COLOR_IDS: readonly DiffColors[];
export const MOTION_IDS: readonly MotionSpeed[];
export const DEFAULT_APPEARANCE: Appearance;
export const SIDEBAR_SIZES: readonly { id: SizeStep; label: string; delta: number }[];
export const CHAT_SIZES: readonly { id: SizeStep; label: string; px: number }[];
export const CODE_SIZES: readonly { id: SizeStep; label: string; px: number }[];
export const CHAT_WIDTHS: readonly { id: ChatWidth; label: string; px: number | null }[];
export const SIDEBAR_USAGE_MODES: readonly { id: SidebarUsageMode; label: string }[];
export const PROVIDER_ICON_STYLES: readonly { id: ProviderIconStyle; label: string }[];
export const DIFF_PAIRS: readonly DiffPair[];
export const MOTION_SPEEDS: readonly { id: MotionSpeed; label: string; scale: number }[];
export const UI_FONTS: readonly FontOption[];
export const MONO_FONTS: readonly FontOption[];
export const PHONE_TEXT_SIZES: readonly { id: SizeStep; label: string; px: number }[];
export const PHONE_CODE_SIZES: readonly { id: SizeStep; label: string; px: number }[];
export function clampChatWidth(px: unknown): number;
export function parseAppearance(raw: unknown): Appearance;
export function fontStack(list: readonly FontOption[], id: string, installed: (family: string) => boolean): string;
