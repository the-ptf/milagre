import { themes } from "@milagre/shared/themes";
import { searchTrail } from "@milagre/shared/settings-search";
import type { SettingsSection } from "../components/Settings";
import type { Command } from "./commands";
import { SECTION_KEYWORDS, SECTION_TITLES, SETTINGS_INDEX } from "./settings-index.ts";
import type { AppSettings } from "./settings";
import { computerNoun } from "./shortcut-hints.ts";

/** Explicit values make commands searchable and safe to run more than once. */
export function settingsCommands(settings: AppSettings, update: (patch: Partial<AppSettings>) => void): Command[] {
  function choice<K extends keyof AppSettings>(key: K, value: AppSettings[K], label: string, keywords = ""): Command {
    return {
      id: `setting:${key}:${value}`,
      label,
      keywords,
      group: "Quick settings",
      icon: "settings",
      detail: settings[key] === value ? "Current" : undefined,
      run: () => update({ [key]: value }),
    };
  }

  function appearanceChoice<K extends keyof AppSettings["appearance"]>(key: K, value: AppSettings["appearance"][K], label: string, keywords = ""): Command {
    return {
      id: `setting:appearance:${key}:${value}`,
      label,
      keywords,
      group: "Quick settings",
      icon: "settings",
      detail: settings.appearance[key] === value ? "Current" : undefined,
      run: () => update({ appearance: { ...settings.appearance, [key]: value } }),
    };
  }

  return [
    choice("theme", "dark", "Mode: Dark", "appearance color mode"),
    choice("theme", "light", "Mode: Light", "appearance color mode"),
    choice("theme", "system", "Mode: System", "appearance color mode automatic"),
    ...themes.map((theme) =>
      choice("colorTheme", theme.id, `Theme: ${theme.group === "Catppuccin" ? `Catppuccin ${theme.name}` : theme.name}`, "appearance color theme"),
    ),
    choice("usageDisplay", "used", "Usage: Used", "plan limits"),
    choice("usageDisplay", "remaining", "Usage: Remaining", "plan limits left"),
    choice("showUsageInSidebar", true, "Sidebar usage: Show", "on enable plan limits"),
    choice("showUsageInSidebar", false, "Sidebar usage: Hide", "off disable plan limits"),
    appearanceChoice("sidebarUsage", "expanded", "Sidebar usage: Expanded", "appearance plan limits rows"),
    appearanceChoice("sidebarUsage", "compact", "Sidebar usage: Compact", "appearance plan limits icons one line"),
    appearanceChoice("providerIcons", "original", "Provider icons: Original", "appearance logos brand colors"),
    appearanceChoice("providerIcons", "simplified", "Provider icons: Simplified", "appearance logos monochrome black white"),
    choice("chatOrder", "created", "Chat order: Newest Chat first", "sidebar sort created date"),
    choice("chatOrder", "recent", "Chat order: Latest message first", "sidebar sort recent activity"),
    choice("claudeReplies", "concise", "Claude replies: Concise", "short responses"),
    choice("claudeReplies", "normal", "Claude replies: Normal", "responses"),
    ...(
      [
        ["tldrEnabled", "TLDR writing", "replies responses"],
        ["notifyOnCompletion", "Notify when finished", "notifications completion"],
        ["notifyWhenWaiting", "Notify when waiting", "notifications approval questions"],
        ["showDockBadge", "Dock badge", "unread count"],
        ["floatingInbox", "Floating inbox", "experimental notification bar"],
        ["keepAwake", `Keep the ${computerNoun} awake`, "sleep reachable lock screen saver"],
      ] as const
    ).flatMap(([key, label, keywords]) => [
      choice(key, true, `${label}: On`, `${keywords} enable`),
      choice(key, false, `${label}: Off`, `${keywords} disable`),
    ]),
  ];
}

/**
 * Every Settings page and every row on one, found by typing in ⌘K. A page opens Settings there; a row opens its page
 * scrolled to the row and lit up, as the Settings search does.
 */
export function settingsPageCommands(open: (section: SettingsSection, row?: string) => void): Command[] {
  const pages = Object.entries(SECTION_TITLES) as [keyof typeof SECTION_TITLES, string][];
  return [
    ...pages.map(([section, title]): Command => ({
      id: `settings-page:${section}`,
      label: title,
      group: "Settings",
      icon: "settings",
      detail: "Settings",
      keywords: `settings preferences ${SECTION_KEYWORDS[section] ?? ""}`,
      searchOnly: true,
      run: () => open(section),
    })),
    ...SETTINGS_INDEX.map((entry): Command => {
      const page = SECTION_TITLES[entry.page as keyof typeof SECTION_TITLES] ?? entry.page;
      return {
        id: `settings-row:${entry.page}:${entry.group ?? ""}:${entry.title}`,
        label: entry.title,
        group: "Settings",
        icon: "settings",
        detail: searchTrail(entry, page),
        keywords: [page, entry.description, entry.keywords].filter(Boolean).join(" "),
        searchOnly: true,
        run: () => open(entry.page, entry.title),
      };
    }),
  ];
}
