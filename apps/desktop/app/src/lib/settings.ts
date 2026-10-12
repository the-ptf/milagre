import { useEffect, useMemo, useSyncExternalStore } from "react";
import { MODEL_CATALOG, PERMISSION_MODES } from "../model.ts";
import type { PermissionMode } from "../model";
import { DEFAULT_THEME_ID, parseCustomTheme, resolvePalette, resolveThemeSettings } from "@milagre/shared/themes";
import type { CustomTheme, ThemeChoice } from "@milagre/shared/themes";
import type { ChatOrder } from "./chat-list";
import { DESKTOP_CHAT_ROW_SHOW, parseChatRowShow, type ChatRowShow } from "@milagre/shared/chat-row";
import { THEME_EVENT, applyPalette } from "./theme-sheet.ts";

export type ThemePreference = "system" | "light" | "dark";
/** Whether plan usage reads as the share used or the share left. */
export type UsageDisplay = "used" | "remaining";
/** How long Claude's replies run: Concise is Claude Code's own terse output style. */
export type ClaudeReplies = "concise" | "normal";

export interface AppSettings {
  theme: ThemePreference;
  /** The color theme; each has a light and a dark palette, and `theme` (Mode) picks which. */
  colorTheme: ThemeChoice;
  /** Experimental: the Custom theme tile and editor. */
  customThemeEnabled: boolean;
  /** Seeds for the Custom theme, kept when the switch is turned off. */
  customTheme: CustomTheme | null;
  defaultModelId: string;
  defaultPermissionMode: PermissionMode;
  usageDisplay: UsageDisplay;
  showUsageInSidebar: boolean;
  /** Show a system notification when a chat waits on an approval or question while Milagre is in the background. */
  notifyWhenWaiting: boolean;
  notifyOnCompletion: boolean;
  showDockBadge: boolean;
  /** The top-right button that opens a chat waiting on the user in another project. */
  showAttentionButton: boolean;
  /** Experimental: a thin screen-edge bar and an inbox over other apps. */
  floatingInbox: boolean;
  floatingInboxActivity: boolean;
  /** Keep the Mac from sleeping while an agent works; the screen can still turn off. */
  keepAwake: boolean;
  /** The editor that "Open in" uses, by id; empty means the first one found. */
  editorId: string;
  /** Applies to Claude only; Codex is unchanged. */
  claudeReplies: ClaudeReplies;
  /** Apply TLDR writing rules to both providers. */
  tldrEnabled: boolean;
  /** Sidebar chats by start date, or with the latest message first. */
  chatOrder: ChatOrder;
  /** What a sidebar chat row's second line shows (the Filters menu's Show). */
  chatRowShow: ChatRowShow;
  /** Experimental: the old sidebar, with the project menu on top and only the open Project's chats, instead of every
   * Project and Link with its chats. A new key, so the old opt-in (sidebarAllProjects, saved false for everyone) is dropped. */
  legacySidebar: boolean;
  /** Experimental: a reply's tool calls and the text between them show in the chat, one row each, instead of folding into one line. */
  muriloMode: boolean;
  /** Experimental: drive the chats of other Macs running Milagre from this window (Add computer, the computers popover). */
  otherComputers: boolean;
  /** Experimental: turning Ultracode on plays the Mortal Kombat Fatality overlay and the announcer's voice. */
  ultracodeFatality: boolean;
  /** Let the blurred desktop show through the window (macOS). */
  windowTranslucent: boolean;
  /** How much of the desktop shows through the window's own background, 10 to 100. */
  windowTranslucency: number;
  /** How much shows through the sidebar and panels, 10 to 90. */
  panelTranslucency: number;
  /** Keep the dot grid while translucent. */
  translucentDots: boolean;
}

const STORAGE_KEY = "milagre-settings";
const LEGACY_THEME_KEY = "milagre-theme";
const THEMES: ThemePreference[] = ["system", "light", "dark"];
const USAGE_DISPLAYS: UsageDisplay[] = ["used", "remaining"];
const CLAUDE_REPLIES: ClaudeReplies[] = ["concise", "normal"];
const CHAT_ORDERS: ChatOrder[] = ["created", "recent"];
export const WINDOW_TRANSLUCENCY_RANGE = { min: 10, max: 100, step: 5 };
export const PANEL_TRANSLUCENCY_RANGE = { min: 10, max: 90, step: 5 };
const clampTo = (value: unknown, range: { min: number; max: number }, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : fallback;
const DEFAULTS: AppSettings = {
  theme: "system",
  colorTheme: DEFAULT_THEME_ID,
  customThemeEnabled: false,
  customTheme: null,
  defaultModelId: MODEL_CATALOG[0].id,
  defaultPermissionMode: "ask",
  usageDisplay: "used",
  showUsageInSidebar: true,
  notifyWhenWaiting: true,
  notifyOnCompletion: true,
  showDockBadge: true,
  showAttentionButton: true,
  floatingInbox: false,
  floatingInboxActivity: true,
  keepAwake: true,
  editorId: "",
  claudeReplies: "concise",
  tldrEnabled: true,
  chatOrder: "created",
  chatRowShow: DESKTOP_CHAT_ROW_SHOW,
  legacySidebar: false,
  muriloMode: false,
  otherComputers: false,
  ultracodeFatality: false,
  windowTranslucent: false,
  windowTranslucency: 80,
  panelTranslucency: 40,
  translucentDots: true,
};

function load(): AppSettings {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<AppSettings>;
    const legacyTheme = window.localStorage.getItem(LEGACY_THEME_KEY);
    const theme = saved.theme ?? legacyTheme;
    const customTheme = parseCustomTheme(saved.customTheme);
    return {
      theme: THEMES.includes(theme as ThemePreference) ? (theme as ThemePreference) : DEFAULTS.theme,
      // Any saved id is kept: the agents report models the maintained list lacks, and App falls back
      // to a provider's recommended model when the saved one isn't offered.
      customThemeEnabled: typeof saved.customThemeEnabled === "boolean" ? saved.customThemeEnabled : DEFAULTS.customThemeEnabled,
      customTheme,
      colorTheme: resolveThemeSettings({ ...saved, customTheme }),
      defaultModelId: typeof saved.defaultModelId === "string" && saved.defaultModelId ? saved.defaultModelId : DEFAULTS.defaultModelId,
      defaultPermissionMode: PERMISSION_MODES.some((mode) => mode.id === saved.defaultPermissionMode)
        ? saved.defaultPermissionMode!
        : DEFAULTS.defaultPermissionMode,
      usageDisplay: USAGE_DISPLAYS.includes(saved.usageDisplay as UsageDisplay) ? saved.usageDisplay! : DEFAULTS.usageDisplay,
      showUsageInSidebar: typeof saved.showUsageInSidebar === "boolean" ? saved.showUsageInSidebar : DEFAULTS.showUsageInSidebar,
      notifyWhenWaiting: typeof saved.notifyWhenWaiting === "boolean" ? saved.notifyWhenWaiting : DEFAULTS.notifyWhenWaiting,
      notifyOnCompletion: typeof saved.notifyOnCompletion === "boolean" ? saved.notifyOnCompletion : DEFAULTS.notifyOnCompletion,
      showDockBadge: typeof saved.showDockBadge === "boolean" ? saved.showDockBadge : DEFAULTS.showDockBadge,
      showAttentionButton: typeof saved.showAttentionButton === "boolean" ? saved.showAttentionButton : DEFAULTS.showAttentionButton,
      floatingInbox: typeof saved.floatingInbox === "boolean" ? saved.floatingInbox : false,
      floatingInboxActivity: typeof saved.floatingInboxActivity === "boolean" ? saved.floatingInboxActivity : true,
      keepAwake: typeof saved.keepAwake === "boolean" ? saved.keepAwake : DEFAULTS.keepAwake,
      editorId: typeof saved.editorId === "string" ? saved.editorId : DEFAULTS.editorId,
      tldrEnabled: typeof saved.tldrEnabled === "boolean" ? saved.tldrEnabled : DEFAULTS.tldrEnabled,
      claudeReplies: CLAUDE_REPLIES.includes(saved.claudeReplies as ClaudeReplies) ? saved.claudeReplies! : DEFAULTS.claudeReplies,
      chatOrder: CHAT_ORDERS.includes(saved.chatOrder as ChatOrder) ? saved.chatOrder! : DEFAULTS.chatOrder,
      chatRowShow: parseChatRowShow(saved.chatRowShow, DEFAULTS.chatRowShow),
      legacySidebar: typeof saved.legacySidebar === "boolean" ? saved.legacySidebar : DEFAULTS.legacySidebar,
      muriloMode: typeof saved.muriloMode === "boolean" ? saved.muriloMode : DEFAULTS.muriloMode,
      otherComputers: typeof saved.otherComputers === "boolean" ? saved.otherComputers : DEFAULTS.otherComputers,
      ultracodeFatality: typeof saved.ultracodeFatality === "boolean" ? saved.ultracodeFatality : DEFAULTS.ultracodeFatality,
      windowTranslucent: typeof saved.windowTranslucent === "boolean" ? saved.windowTranslucent : DEFAULTS.windowTranslucent,
      windowTranslucency: clampTo(saved.windowTranslucency, WINDOW_TRANSLUCENCY_RANGE, DEFAULTS.windowTranslucency),
      panelTranslucency: clampTo(saved.panelTranslucency, PANEL_TRANSLUCENCY_RANGE, DEFAULTS.panelTranslucency),
      translucentDots: typeof saved.translucentDots === "boolean" ? saved.translucentDots : DEFAULTS.translucentDots,
    };
  } catch {
    return DEFAULTS;
  }
}

let current = load();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSettings() {
  return current;
}

export function updateSettings(patch: Partial<AppSettings>) {
  current = { ...current, ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Settings still apply for this session when storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

export function useSettings() {
  return useSyncExternalStore(subscribe, getSettings);
}
// The bar, inbox and main window share the saved settings, including live theme changes.
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  current = load();
  listeners.forEach((listener) => listener());
});

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function subscribeSystemTheme(listener: () => void) {
  darkQuery.addEventListener("change", listener);
  return () => darkQuery.removeEventListener("change", listener);
}

export function useResolvedScheme(): "light" | "dark" {
  const { theme } = useSettings();
  const systemDark = useSyncExternalStore(subscribeSystemTheme, () => darkQuery.matches);
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

/** ⌘⇧T: flips to the opposite of what's on screen, pinning light or dark even from System. */
export function toggleTheme() {
  const { theme } = getSettings();
  const dark = theme === "system" ? darkQuery.matches : theme === "dark";
  updateSettings({ theme: dark ? "light" : "dark" });
}

function currentScheme(): "light" | "dark" {
  const { theme } = getSettings();
  return theme === "system" ? (darkQuery.matches ? "dark" : "light") : theme;
}

/** Paints the saved theme before React's first render, so a non-default theme never flashes Milagre Blue. */
export function applyThemeNow() {
  const { colorTheme, customTheme } = getSettings();
  const scheme = currentScheme();
  document.documentElement.classList.toggle("dark", scheme === "dark");
  applyPalette(resolvePalette(colorTheme, scheme, customTheme), scheme);
}

export function useApplyTheme() {
  const scheme = useResolvedScheme();
  const { colorTheme, customTheme, windowTranslucent, windowTranslucency, panelTranslucency } = useSettings();
  const palette = useMemo(() => resolvePalette(colorTheme, scheme, customTheme), [colorTheme, scheme, customTheme]);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.classList.toggle("dark", scheme === "dark");
    applyPalette(palette, scheme);
    const frame = window.requestAnimationFrame(() => root.classList.remove("theme-switching"));
    return () => window.cancelAnimationFrame(frame);
  }, [palette, scheme]);
  // The window itself goes see-through in the main process; the renderer's backgrounds follow.
  useEffect(() => {
    document.documentElement.classList.toggle("translucent", windowTranslucent);
    window.dispatchEvent(new Event(THEME_EVENT));
    void window.milagre?.setWindowTranslucent(windowTranslucent, scheme, palette.page).catch(() => {});
  }, [windowTranslucent, scheme, palette.page]);
  useEffect(() => {
    document.documentElement.style.setProperty("--window-translucency", String(windowTranslucency / 100));
    document.documentElement.style.setProperty("--panel-translucency", String(panelTranslucency / 100));
    window.dispatchEvent(new Event(THEME_EVENT));
  }, [windowTranslucency, panelTranslucency]);
}
