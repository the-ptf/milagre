import { preferenceStorage as localStorage } from "./preference-storage.ts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { MODEL_CATALOG, PERMISSION_MODES } from "../model.ts";
import type { PermissionMode } from "../model";
import { DEFAULT_THEME_ID, parseCustomTheme, resolvePalette, resolveThemeSettings } from "@milagre/shared/themes";
import type { CustomTheme, ThemeChoice } from "@milagre/shared/themes";
import type { ChatOrder } from "./chat-list";
import { DESKTOP_CHAT_ROW_SHOW, parseChatRowShow, type ChatRowShow } from "@milagre/shared/chat-row";
import { normalizeSnoozeMinutes, normalizeSnoozePresets, SNOOZE_DEFAULTS, type SnoozePreset } from "@milagre/shared/snooze";
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
import { parseUsageInSidebar, type UsageInSidebar } from "@milagre/shared/usage";

import { parseNotificationSchedule, type NotificationSchedule } from "@milagre/shared/notification-schedule";
import {
  dictationLanguage,
  whisperModelFor,
  dictationShortcutMode,
  dictationFixModel,
  type DictationShortcutMode,
  type DictationFixModel,
} from "@milagre/shared/dictation";
import { parseDictationAction, type DictationActionPreference } from "@milagre/shared/voice-dictation";

export type ThemePreference = "system" | "light" | "dark";
export type UsageDisplay = "used" | "remaining";
export type ClaudeReplies = "concise" | "normal";
export type OpenLinksIn = "milagre" | "external";

export interface AppSettings {
  theme: ThemePreference;
  colorTheme: ThemeChoice;
  customThemeEnabled: boolean;
  customTheme: CustomTheme | null;
  defaultModelId: string;
  defaultPermissionMode: PermissionMode;
  usageDisplay: UsageDisplay;
  usageInSidebar: UsageInSidebar;
  notifyWhenWaiting: boolean;
  notifyOnCompletion: boolean;
  showDockBadge: boolean;
  floatingInbox: boolean;
  floatingInboxActivity: boolean;
  keepAwake: boolean;
  editorId: string;
  claudeReplies: ClaudeReplies;
  openLinksIn: OpenLinksIn;
  tldrEnabled: boolean;
  chatOrder: ChatOrder;
  chatList: ChatList;
  chatRowShow: ChatRowShow;
  snoozeMinutes: number;
  snoozePresets: SnoozePreset[];
  toolCallDisplay: ToolCallDisplay;
  expandReasoning: boolean;
  newChatGlance: boolean;
  workspaceTabs: boolean;
  showContextSize: boolean;
  compactButtonDisplay: CompactButtonDisplay;
  otherComputers: boolean;
  ultracodeFatality: boolean;
  notificationChime: NotificationChime;
  notificationSchedule: NotificationSchedule | null;
  routineNudges: boolean;
  appearance: Appearance;
  dictationLanguage: string;
  dictationModel: string;
  dictationAction: DictationActionPreference;
  dictationShortcutMode: DictationShortcutMode;
  dictationEnabled: boolean;
  dictationSymbols: boolean;
  dictationFixUp: boolean;
  dictationFixModel: DictationFixModel;
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
  usageInSidebar: "button",
  notifyWhenWaiting: true,
  notifyOnCompletion: true,
  showDockBadge: true,
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
  snoozeMinutes: SNOOZE_DEFAULTS.minutes,
  snoozePresets: normalizeSnoozePresets(undefined),
  toolCallDisplay: "compact",
  expandReasoning: false,
  newChatGlance: false,
  workspaceTabs: false,
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
  dictationShortcutMode: "hold",
  dictationEnabled: true,
  dictationSymbols: false,
  dictationFixUp: true,
  dictationFixModel: "auto",
};

function load(): AppSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<AppSettings> & { muriloMode?: unknown; showUsageInSidebar?: unknown };
    const legacyTheme = localStorage.getItem(LEGACY_THEME_KEY);
    const theme = saved.theme ?? legacyTheme;
    const customTheme = parseCustomTheme(saved.customTheme);
    return {
      theme: THEMES.has(theme as ThemePreference) ? (theme as ThemePreference) : DEFAULTS.theme,
      customThemeEnabled: typeof saved.customThemeEnabled === "boolean" ? saved.customThemeEnabled : DEFAULTS.customThemeEnabled,
      customTheme,
      colorTheme: resolveThemeSettings({ ...saved, customTheme }),
      defaultModelId: typeof saved.defaultModelId === "string" && saved.defaultModelId ? saved.defaultModelId : DEFAULTS.defaultModelId,
      defaultPermissionMode: PERMISSION_MODES.some((mode) => mode.id === saved.defaultPermissionMode)
        ? saved.defaultPermissionMode!
        : DEFAULTS.defaultPermissionMode,
      usageDisplay: USAGE_DISPLAYS.has(saved.usageDisplay as UsageDisplay) ? saved.usageDisplay! : DEFAULTS.usageDisplay,
      usageInSidebar: parseUsageInSidebar(saved.usageInSidebar, saved.showUsageInSidebar),
      notifyWhenWaiting: typeof saved.notifyWhenWaiting === "boolean" ? saved.notifyWhenWaiting : DEFAULTS.notifyWhenWaiting,
      notifyOnCompletion: typeof saved.notifyOnCompletion === "boolean" ? saved.notifyOnCompletion : DEFAULTS.notifyOnCompletion,
      showDockBadge: typeof saved.showDockBadge === "boolean" ? saved.showDockBadge : DEFAULTS.showDockBadge,
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
      snoozeMinutes: normalizeSnoozeMinutes(saved.snoozeMinutes),
      snoozePresets: normalizeSnoozePresets(saved.snoozePresets),
      toolCallDisplay: parseToolCallDisplay(saved.toolCallDisplay, saved.muriloMode),
      expandReasoning: typeof saved.expandReasoning === "boolean" ? saved.expandReasoning : DEFAULTS.expandReasoning,
      newChatGlance: typeof saved.newChatGlance === "boolean" ? saved.newChatGlance : DEFAULTS.newChatGlance,
      workspaceTabs: typeof saved.workspaceTabs === "boolean" ? saved.workspaceTabs : DEFAULTS.workspaceTabs,
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
      dictationShortcutMode: dictationShortcutMode(saved.dictationShortcutMode),
      dictationEnabled: saved.dictationEnabled !== false,
      dictationSymbols: saved.dictationSymbols === true,
      dictationFixUp: typeof saved.dictationFixUp === "boolean" ? saved.dictationFixUp : DEFAULTS.dictationFixUp,
      dictationFixModel: dictationFixModel(saved.dictationFixModel),
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
  } catch {}
  listeners.forEach((listener) => listener());
}

export function useSettings() {
  return useSyncExternalStore(subscribe, getSettings);
}
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

export function toggleTheme() {
  const { theme } = getSettings();
  const dark = theme === "system" ? darkQuery.matches : theme === "dark";
  updateSettings({ theme: dark ? "light" : "dark" });
}

function currentScheme(): "light" | "dark" {
  const { theme } = getSettings();
  return theme === "system" ? (darkQuery.matches ? "dark" : "light") : theme;
}

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
  useEffect(() => {
    void window.milagre?.setWindowBackground(palette.page).catch(() => {});
  }, [palette.page]);
}
