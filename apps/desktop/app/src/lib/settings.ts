import { preferenceStorage as localStorage } from "./preference-storage.ts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { MODEL_CATALOG, PERMISSION_MODES } from "../model.ts";
import type { PermissionMode } from "../model";
import { DEFAULT_THEME_ID, parseCustomTheme, resolvePalette, resolveThemeSettings } from "@milagre/shared/themes";
import type { CustomTheme, ThemeChoice } from "@milagre/shared/themes";
import type { ChatOrder } from "./chat-list";
import { DESKTOP_CHAT_ROW_SHOW, parseChatRowShow, type ChatRowShow } from "@milagre/shared/chat-row";
import {
  parseChatList,
  parseCompactButtonDisplay,
  parseToolCallDisplay,
  type ChatList,
  type CompactButtonDisplay,
  type ToolCallDisplay,
} from "@milagre/shared/chat-display";
import { DEFAULT_NOTIFICATION_CHIME, parseNotificationChime, type NotificationChime } from "@milagre/shared/notification-chimes";
import { applyPalette } from "./theme-sheet.ts";
import { applyAppearance } from "./appearance.ts";
import { DEFAULT_APPEARANCE, parseAppearance, type Appearance } from "@milagre/shared/appearance";

import { parseNotificationSchedule, type NotificationSchedule } from "@milagre/shared/notification-schedule";
import { dictationLanguage, whisperModelFor } from "@milagre/shared/dictation";
import { parseDictationAction, type DictationActionPreference } from "@milagre/shared/voice-dictation";

export type ThemePreference = "system" | "light" | "dark";
/** Whether plan usage reads as the share used or the share left. */
export type UsageDisplay = "used" | "remaining";
/** How long Claude's replies run: Concise is Claude Code's own terse output style. */
export type ClaudeReplies = "concise" | "normal";
/** Settings › Browser: web links in replies and the Ports pill open in the Browser panel, or in the user's browser. */
export type OpenLinksIn = "milagre" | "external";

export interface AppSettings {
  theme: ThemePreference;
  /** The color theme; each has a light and a dark palette, and `theme` (Mode) picks which. */
  colorTheme: ThemeChoice;
  /** Settings › Appearance: the Custom theme tile and editor. */
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
  /** Where web links open; ⌘-click opens them in the other one. */
  openLinksIn: OpenLinksIn;
  /** Apply TLDR writing rules to both providers. */
  tldrEnabled: boolean;
  /** Sidebar chats by start date, or with the latest message first. */
  chatOrder: ChatOrder;
  /** Settings › Chat: the sidebar lists every Chat in one list, or groups them by Project. */
  chatList: ChatList;
  /** What a sidebar chat row's second line shows (the Filters menu's Show). */
  chatRowShow: ChatRowShow;
  /** Settings › Chat: a reply's tool calls fold into one line, or show one row each with the text between them. */
  toolCallDisplay: ToolCallDisplay;
  /** Settings › Chat: thinking rows start open. */
  expandReasoning: boolean;
  showContextSize: boolean;
  compactButtonDisplay: CompactButtonDisplay;
  /** Settings › Devices: drive the chats of other Macs running Milagre from this window (Add computer, the computers popover). */
  otherComputers: boolean;
  /** Experimental: turning Ultracode on plays the Mortal Kombat Fatality overlay and the announcer's voice. */
  ultracodeFatality: boolean;
  /** Settings › Notifications: the sound a chat's notification plays, instead of the system's. */
  notificationChime: NotificationChime;
  notificationSchedule: NotificationSchedule | null;
  /** Settings › Routines: the Routines button and Routine rows show a dot while a Run's Chat is unread on this Mac. */
  routineNudges: boolean;
  /** Settings › Appearance: fonts, sizes, chat width, diff colors and motion. */
  appearance: Appearance;
  /** Settings › Chat: the language dictation listens for, a Whisper code, or "auto" to detect it each take. */
  dictationLanguage: string;
  /** Settings › Chat: the Whisper model dictation uses on this computer, an id from WHISPER_MODELS.desktop. */
  dictationModel: string;
  dictationAction: DictationActionPreference;
}

const STORAGE_KEY = "milagre-settings";
const LEGACY_THEME_KEY = "milagre-theme";
const THEMES = new Set<ThemePreference>(["system", "light", "dark"]);
const USAGE_DISPLAYS = new Set<UsageDisplay>(["used", "remaining"]);
const CLAUDE_REPLIES = new Set<ClaudeReplies>(["concise", "normal"]);
const CHAT_ORDERS = new Set<ChatOrder>(["created", "recent"]);
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
  openLinksIn: "milagre",
  tldrEnabled: true,
  chatOrder: "created",
  chatList: "list",
  chatRowShow: DESKTOP_CHAT_ROW_SHOW,
  toolCallDisplay: "compact",
  expandReasoning: false,
  showContextSize: true,
  compactButtonDisplay: "threshold",
  otherComputers: false,
  ultracodeFatality: false,
  notificationChime: DEFAULT_NOTIFICATION_CHIME,
  notificationSchedule: null,
  routineNudges: true,
  appearance: DEFAULT_APPEARANCE,
  dictationLanguage: "auto",
  dictationModel: whisperModelFor("desktop", undefined).id,
  dictationAction: "paste",
};

function load(): AppSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<AppSettings> & { muriloMode?: unknown };
    const legacyTheme = localStorage.getItem(LEGACY_THEME_KEY);
    const theme = saved.theme ?? legacyTheme;
    const customTheme = parseCustomTheme(saved.customTheme);
    return {
      theme: THEMES.has(theme as ThemePreference) ? (theme as ThemePreference) : DEFAULTS.theme,
      // Any saved id is kept: the agents report models the maintained list lacks, and App falls back
      // to a provider's recommended model when the saved one isn't offered.
      customThemeEnabled: typeof saved.customThemeEnabled === "boolean" ? saved.customThemeEnabled : DEFAULTS.customThemeEnabled,
      customTheme,
      colorTheme: resolveThemeSettings({ ...saved, customTheme }),
      defaultModelId: typeof saved.defaultModelId === "string" && saved.defaultModelId ? saved.defaultModelId : DEFAULTS.defaultModelId,
      defaultPermissionMode: PERMISSION_MODES.some((mode) => mode.id === saved.defaultPermissionMode)
        ? saved.defaultPermissionMode!
        : DEFAULTS.defaultPermissionMode,
      usageDisplay: USAGE_DISPLAYS.has(saved.usageDisplay as UsageDisplay) ? saved.usageDisplay! : DEFAULTS.usageDisplay,
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
      claudeReplies: CLAUDE_REPLIES.has(saved.claudeReplies as ClaudeReplies) ? saved.claudeReplies! : DEFAULTS.claudeReplies,
      openLinksIn: saved.openLinksIn === "external" ? "external" : DEFAULTS.openLinksIn,
      chatOrder: CHAT_ORDERS.has(saved.chatOrder as ChatOrder) ? saved.chatOrder! : DEFAULTS.chatOrder,
      chatList: parseChatList(saved.chatList),
      chatRowShow: parseChatRowShow(saved.chatRowShow, DEFAULTS.chatRowShow),
      toolCallDisplay: parseToolCallDisplay(saved.toolCallDisplay, saved.muriloMode),
      expandReasoning: typeof saved.expandReasoning === "boolean" ? saved.expandReasoning : DEFAULTS.expandReasoning,
      showContextSize: typeof saved.showContextSize === "boolean" ? saved.showContextSize : DEFAULTS.showContextSize,
      compactButtonDisplay: parseCompactButtonDisplay(saved.compactButtonDisplay),
      otherComputers: typeof saved.otherComputers === "boolean" ? saved.otherComputers : DEFAULTS.otherComputers,
      ultracodeFatality: typeof saved.ultracodeFatality === "boolean" ? saved.ultracodeFatality : DEFAULTS.ultracodeFatality,
      notificationChime: parseNotificationChime(saved.notificationChime),
      notificationSchedule: (() => {
        try {
          return parseNotificationSchedule(saved.notificationSchedule);
        } catch {
          return null;
        }
      })(),
      routineNudges: typeof saved.routineNudges === "boolean" ? saved.routineNudges : DEFAULTS.routineNudges,
      appearance: parseAppearance(saved.appearance),
      dictationLanguage: dictationLanguage(saved.dictationLanguage),
      dictationModel: whisperModelFor("desktop", saved.dictationModel).id,
      dictationAction: parseDictationAction(saved.dictationAction),
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
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
  const { colorTheme, customTheme, appearance } = getSettings();
  const scheme = currentScheme();
  document.documentElement.classList.toggle("dark", scheme === "dark");
  applyPalette(resolvePalette(colorTheme, scheme, customTheme));
  applyAppearance(appearance);
}

export function useApplyTheme() {
  const scheme = useResolvedScheme();
  const { colorTheme, customTheme, appearance } = useSettings();
  const palette = useMemo(() => resolvePalette(colorTheme, scheme, customTheme), [colorTheme, scheme, customTheme]);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.classList.toggle("dark", scheme === "dark");
    applyPalette(palette);
    applyAppearance(appearance);
    const frame = window.requestAnimationFrame(() => root.classList.remove("theme-switching"));
    return () => window.cancelAnimationFrame(frame);
  }, [palette, scheme, appearance]);
  // The window behind the page takes the page's color, so a resize never flashes another one.
  useEffect(() => {
    void window.milagre?.setWindowBackground(palette.page).catch(() => {});
  }, [palette.page]);
}
