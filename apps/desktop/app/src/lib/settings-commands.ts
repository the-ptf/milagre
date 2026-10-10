import { themes } from "@milagre/shared/themes";
import type { Command } from "./commands";
import type { AppSettings } from "./settings";

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
    choice("chatOrder", "created", "Chat order: Newest chat first", "sidebar sort created date"),
    choice("chatOrder", "recent", "Chat order: Latest message first", "sidebar sort recent activity"),
    choice("claudeReplies", "concise", "Claude replies: Concise", "short responses"),
    choice("claudeReplies", "normal", "Claude replies: Normal", "responses"),
    ...(
      [
        ["tldrEnabled", "TLDR writing", "replies responses"],
        ["notifyOnCompletion", "Notify when finished", "notifications completion"],
        ["notifyWhenWaiting", "Notify when waiting", "notifications approval questions"],
        ["showDockBadge", "Dock badge", "unread count"],
        ["showAttentionButton", "Attention button", "other projects waiting approval questions"],
        ["floatingInbox", "Floating inbox", "experimental notification bar"],
        ["keepAwake", "Keep awake while agents work", "sleep"],
      ] as const
    ).flatMap(([key, label, keywords]) => [
      choice(key, true, `${label}: On`, `${keywords} enable`),
      choice(key, false, `${label}: Off`, `${keywords} disable`),
    ]),
  ];
}
