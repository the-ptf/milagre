import { AUTO_UPDATE_HINT, AUTO_UPDATE_TITLE } from "@milagre/shared/auto-update";
import { CHAT_LIST_TITLE } from "@milagre/shared/chat-display";
import { CHAT_ROW_FIELDS } from "@milagre/shared/chat-row";
import { DEVICE_NOTES_DESCRIPTION, DEVICE_NOTES_LABEL } from "@milagre/shared/device-notes";
import { LINEAR_HINT, LINEAR_MOVE_TO_STARTED_HINT, LINEAR_MOVE_TO_STARTED_TITLE, LINEAR_TITLE } from "@milagre/shared/linear";
import { MAIN_SYNC_HINT, MAIN_SYNC_TITLE } from "@milagre/shared/main-sync";
import { IMPORT_INTRO, IMPORT_TITLE } from "@milagre/shared/ade-import";
import { NEW_CHAT_STATS_HINT, NEW_CHAT_STATS_LABEL } from "@milagre/shared/new-chat-glance";
import { searchSettings, type SettingsSearchEntry, type SettingsSearchHit } from "@milagre/shared/settings-search";
import { DESIGN_SECTIONS, DESIGN_SYSTEM_GROUPS } from "./design-system-catalogue.ts";

/**
 * The Settings pages the phone's search can open, by route, with the title each shows and what it needs: "computer" for
 * a page of the connected Mac's settings (hidden with none connected), "ipad" for one only an iPad shows.
 */
export const SETTINGS_PAGES = {
  computers: { title: "Computers" },
  routines: { title: "Routines", needs: "computer" },
  appearance: { title: "Appearance" },
  "chat-display": { title: "Chat" },
  voice: { title: "Voice" },
  "dictation-language": { title: "Dictation language" },
  "dictation-model": { title: "Speech model" },
  notifications: { title: "Notifications" },
  "browser-settings": { title: "Browser" },
  archived: { title: "Archived Chats" },
  models: { title: "Models", needs: "computer" },
  accounts: { title: "Accounts", needs: "computer" },
  usage: { title: "Plan usage", needs: "computer" },
  "token-usage": { title: "Token usage", needs: "computer" },
  skills: { title: "Skills", needs: "computer" },
  mcp: { title: "Connectors", needs: "computer" },
  worktrees: { title: "Worktrees", needs: "computer" },
  connections: { title: "Integrations", needs: "computer" },
  "babysit-prs": { title: "Babysit PRs", needs: "computer" },
  "orchestrator-settings": { title: "Orchestrator", needs: "computer" },
  "orchestrator-memory": { title: "Orchestrator memory", needs: "computer" },
  "phone-sharing": { title: "Phone & sharing", needs: "computer" },
  simlock: { title: "Simlock devices", needs: "computer" },
  "this-mac": { title: "This computer", needs: "computer" },
  "computer-use": { title: "Computer use", needs: "computer" },
  experimental: { title: "Church" },
  "design-system": { title: "Design system" },
  keybindings: { title: "Keybindings", needs: "ipad" },
} as const satisfies Record<string, { title: string; needs?: "computer" | "ipad" }>;

export type SettingsRoute = keyof typeof SETTINGS_PAGES;

export type PhoneSettingsEntry = SettingsSearchEntry<SettingsRoute>;

export const SETTINGS_INDEX: readonly PhoneSettingsEntry[] = [
  {
    page: "notifications",
    title: "Notify when waiting",
    description: "Approvals and questions that need your input.",
    keywords: "alerts push approval question",
  },
  {
    page: "notifications",
    title: "Notify when finished",
    description: "Completed turns and turns that fail.",
    keywords: "alerts push done complete failed",
  },
  {
    page: "notifications",
    title: "Notification schedule",
    keywords: "quiet hours do not disturb weekdays work hours days",
  },
  {
    page: "notifications",
    title: "Notification chime",
    description: "Plays when a Chat finishes or needs you, on this phone. Picking one plays it.",
    keywords: "sound alert tone",
  },
  {
    page: "notifications",
    title: "Live Activities",
    keywords: "lock screen dynamic island show in live activities questions only",
  },

  { page: "appearance", title: "Mode", keywords: "light dark system theme" },
  { page: "appearance", title: "App icon", keywords: "home screen icon alternate dawn black white sunset aurora glass 8-bit pixel" },
  {
    page: "appearance",
    title: "Text size",
    group: "Text and motion",
    description: "Messages and the composer.",
    keywords: "font bigger smaller",
  },
  {
    page: "appearance",
    title: "Code size",
    group: "Text and motion",
    description: "Code blocks and diffs.",
    keywords: "font monospace",
  },
  {
    page: "appearance",
    title: "Diff colors",
    group: "Text and motion",
    description: "Additions and deletions, including change counts.",
    keywords: "green red colorblind",
  },
  {
    page: "appearance",
    title: "Animations",
    group: "Text and motion",
    description: "In-app motion. Navigation transitions stay native.",
    keywords: "motion reduce",
  },
  {
    page: "appearance",
    title: "Provider icons",
    group: "Icons",
    description: "Original colors, or black and white to match the mode.",
    keywords: "logos claude codex",
  },
  {
    page: "appearance",
    title: "Custom theme",
    group: "Custom theme",
    description: "Build a theme from a few colors.",
    keywords: "colors palette",
  },
  {
    page: "appearance",
    title: "Editing",
    group: "Custom theme",
    keywords: "light dark custom theme colors",
  },

  {
    page: "browser-settings",
    title: "Open links in Milagre",
    group: "Browser on this device",
    description: "Open web links in this Chat's Browser. Turn off to use this device's default browser.",
    keywords: "web links safari in-app browser",
  },

  {
    page: "chat-display",
    title: "While the agent works",
    group: "Messages during a turn",
    keywords: "steer queue follow-up send now later",
  },
  {
    page: "models",
    title: "Show size beside Send",
    group: "Context size",
    description: "Tap for usage and Compact now.",
    keywords: "context window tokens usage",
  },
  {
    page: "models",
    title: "Show below threshold",
    group: "Context size",
    keywords: "compact button always",
  },
  {
    page: "models",
    title: "Auto compact quietly",
    group: "Context size",
    description: "Compacts at your limit. No context size, button or notifications.",
    keywords: "compact automatic threshold",
  },
  {
    page: "chat-display",
    title: CHAT_LIST_TITLE,
    group: CHAT_LIST_TITLE,
    keywords: "one list by project grouped sidebar",
  },
  ...CHAT_ROW_FIELDS.filter((field) => field.id !== "computer").map((field) => ({
    page: "chat-display" as const,
    title: field.label,
    group: "Rows show",
    keywords: "chat list row",
  })),
  {
    page: "chat-display",
    title: "Reasoning",
    group: "Reasoning",
    keywords: "thinking folded expanded",
  },
  {
    page: "chat-display",
    title: "Tool calls",
    group: "Tool calls",
    keywords: "compact full detail",
  },
  {
    page: "chat-display",
    title: "Snooze for",
    group: "Snooze",
    keywords: "snooze later remind wake default duration quiet",
  },
  {
    page: "chat-display",
    title: "Snooze options",
    group: "Snooze",
    keywords: "snooze presets menu times later tonight tomorrow next week remind",
  },
  {
    page: "voice",
    title: "Keyboard shortcut",
    keywords: "dictate voice keyboard alt space ipad",
  },
  {
    page: "voice",
    title: "Fix-up model",
    keywords: "correction automatic haiku codex gemini kiro",
  },
  { page: "voice", title: "Enable dictation", keywords: "voice microphone hide disable speech to text shortcut" },
  { page: "voice", title: "Spoken symbols", keywords: "dictation backticks inline code insert newline" },
  {
    page: "voice",
    title: "Fix names with AI",
    keywords: "post processing correction automatic model haiku codex gemini kiro",
  },
  {
    page: "voice",
    title: "When dictation finishes",
    keywords: "voice send insert mic",
  },

  {
    page: "computers",
    title: "Show computers as",
    keywords: "map list routes lan tailscale network",
  },
  {
    page: "computers",
    title: "Name on computers",
    group: "This iPhone",
    keywords: "device phone name",
  },
  {
    page: "experimental",
    title: "Floating inbox",
    description: "A movable inbox button in the Chat. Tap to answer questions or approve requests. Flick it toward the left or right edge to tuck it away.",
    keywords: "button questions approvals",
  },
  {
    page: "experimental",
    title: "Show Chat activity",
    description: "Include working Chats with a progress summary and finished updates. Off: only questions and permission requests.",
    keywords: "floating inbox progress",
  },
  {
    page: "experimental",
    title: "Ultracode Fatality",
    description: "Turning Ultracode on darkens the screen, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud.",
    keywords: "mortal kombat announcer",
  },
  {
    page: "experimental",
    title: NEW_CHAT_STATS_LABEL,
    description: NEW_CHAT_STATS_HINT,
    keywords: "glance cards pull requests usage tokens",
  },
  {
    page: "experimental",
    title: DEVICE_NOTES_LABEL,
    description: DEVICE_NOTES_DESCRIPTION,
    keywords: "sent from phone ipad tokens",
  },

  {
    page: "babysit-prs",
    title: "Babysit new PRs",
    group: "Babysit PRs",
    description:
      "Off by default. When a Chat opens a PR, Milagre adds a Heartbeat to that Chat and watches the PR until it's done. Orchestrator task Chats still on the board are always babysat.",
    keywords: "pull request heartbeat wake the agent for review comments failed checks merge conflicts branch behind",
  },
  {
    page: "babysit-prs",
    title: "Check every",
    group: "Babysit PRs",
    description: "Milagre asks GitHub itself on this interval. The agent only wakes when something new shows up, so idle PRs cost nothing.",
    keywords: "interval minutes poll",
  },
  {
    page: "babysit-prs",
    title: "Resolve threads it answered",
    group: "When something needs fixing",
    description: "On by default. After replying on a thread, the agent marks it resolved.",
    keywords: "review comments",
  },
  {
    page: "babysit-prs",
    title: "The PR is merged or closed",
    group: "Stop babysitting when",
    description: "Always",
  },
  {
    page: "babysit-prs",
    title: "Checks pass and the PR is approved",
    group: "Stop babysitting when",
    description: "Nothing left to address. A comment that lands after this goes unwatched.",
    keywords: "green ci",
  },
  {
    page: "babysit-prs",
    title: "It has watched the PR for",
    group: "Stop babysitting when",
    keywords: "days timeout",
  },
  {
    page: "babysit-prs",
    title: "Watch the PR for",
    group: "Stop babysitting when",
    keywords: "days timeout",
  },
  {
    page: "babysit-prs",
    title: "It failed to fix the same problem",
    group: "Stop babysitting when",
    keywords: "times retries give up",
  },
  {
    page: "babysit-prs",
    title: "Failed to fix the same problem",
    group: "Stop babysitting when",
    keywords: "times retries give up",
  },
  {
    page: "babysit-prs",
    title: "Your own rule",
    group: "Stop babysitting when",
    description: "The agent checks it each time it wakes and ends the Heartbeat when it holds.",
    keywords: "custom condition instructions",
  },
  { page: "babysit-prs", title: "Reset all to defaults" },

  {
    page: "orchestrator-settings",
    title: "Turn on the Orchestrator",
    keywords: "router one box route prompt project model account subchat board church",
  },
  { page: "orchestrator-settings", title: "Name", group: "Name", keywords: "rename orchestrator" },
  { page: "orchestrator-settings", title: "Mascot color", group: "Mascot", keywords: "pebble avatar" },
  {
    page: "orchestrator-settings",
    title: "Router model",
    group: "Routing",
    description: "Sends your prompt, your kept notes and the Project hints to this model's provider, on your account",
  },
  { page: "orchestrator-settings", title: "When no Project fits", group: "Routing", keywords: "ask me best guess" },
  { page: "orchestrator-settings", title: "Account", group: "Routing", keywords: "least used today project's account limit" },
  { page: "orchestrator-settings", title: "Use other computers", group: "Computers", keywords: "load balancing room cpu memory" },
  { page: "orchestrator-settings", title: "Required outcome", group: "Completion", keywords: "done pull request PR created merged agent finished" },
  { page: "orchestrator-settings", title: "Answer threads for me", group: "Autopilot", keywords: "autopilot ask me first off approvals questions" },
  {
    page: "orchestrator-settings",
    title: "Time to veto",
    group: "Autopilot",
    description: "When it isn't sure, it waits this long before answering so you can step in",
  },
  { page: "orchestrator-memory", title: "Read again", group: "Memory", keywords: "import notes claude code codex antigravity kiro" },
  { page: "orchestrator-memory", title: "Forget everything", group: "Memory", keywords: "memory notes reset" },
  { page: "orchestrator-settings", title: "Keep Orchestrator Subchats out of the sidebar", group: "Board", keywords: "hide task chats" },
  { page: "orchestrator-settings", title: "Notify me when a task needs me", group: "Board", keywords: "push alerts" },
  { page: "orchestrator-settings", title: "Show the board", group: "Board", keywords: "collapse hide running needs you in review done" },

  {
    page: "simlock",
    title: "Devices at once",
    group: "Limits",
    description: "Leases this computer holds together. Simlock also caps leases per token.",
    keywords: "simulators emulators leases pool",
  },
  {
    page: "simlock",
    title: "Return a device after",
    group: "Limits",
    description: "A lease ends this long after it started, even while an agent uses it.",
    keywords: "lease minutes hours timeout",
  },

  {
    page: "computer-use",
    title: "Show the agent's cursor",
    keywords: "pointer overlay screen",
  },
  {
    page: "computer-use",
    title: "Accessibility",
    // oxlint-disable-next-line milagre-design/copy-computer -- Computer use is macOS-only: these are the Mac's own permissions
    group: "Permissions on the Mac",
    keywords: "grant permission system settings",
  },
  {
    page: "computer-use",
    title: "Screen Recording",
    // oxlint-disable-next-line milagre-design/copy-computer -- Computer use is macOS-only: these are the Mac's own permissions
    group: "Permissions on the Mac",
    keywords: "grant permission system settings",
  },

  {
    page: "worktrees",
    title: MAIN_SYNC_TITLE,
    group: "Main branch",
    description: MAIN_SYNC_HINT,
    keywords: "git pull fast-forward main branch remote",
  },
  {
    page: "worktrees",
    title: IMPORT_TITLE,
    group: "Add Project",
    description: IMPORT_INTRO,
    keywords: "import migrate t3 code paseo orca threads chats projects move switch",
  },

  {
    page: "this-mac",
    title: AUTO_UPDATE_TITLE,
    group: "Updates",
    description: AUTO_UPDATE_HINT,
    keywords: "install restart upgrade version",
  },

  { page: "token-usage", title: "Period", keywords: "range days week month" },
  { page: "token-usage", title: "Show", keywords: "cost tokens metric" },

  { page: "accounts", title: "Computer", keywords: "paired other remote mac machine manage accounts" },
  {
    page: "accounts",
    title: "Switch accounts at usage limits",
    group: "Usage limits",
    description: "When a Chat hits its plan's usage limit, move its Project to the next signed-in account and continue.",
    keywords: "rate limit automatic switch",
  },
  {
    page: "accounts",
    title: "Continue when the limit resets",
    group: "Usage limits",
    description: "When a Chat hits its plan's usage limit and no other account can take over, continue it at the reset time, up to a day later.",
    keywords: "rate limit resume",
  },

  {
    page: "connections",
    title: LINEAR_TITLE,
    group: "Issue trackers",
    description: LINEAR_HINT,
    keywords: "issues tracker",
  },
  {
    page: "connections",
    title: LINEAR_MOVE_TO_STARTED_TITLE,
    group: "Issue trackers",
    description: LINEAR_MOVE_TO_STARTED_HINT,
    keywords: "linear status started",
  },

  {
    page: "phone-sharing",
    title: "iPhones on a cable",
    group: "Simulators",
    description: "Chats list the paired iPhones on this computer's cable next to its simulators.",
    keywords: "baguette physical real device iphone usb",
  },
  {
    page: "phone-sharing",
    title: "Published pages",
    group: "Designs and artifacts",
    description: "Public links to designs and artifacts.",
    keywords: "share links",
  },

  {
    page: "mcp",
    title: "Custom MCP",
    group: "Milagre MCP",
    keywords: "connection token access config",
  },

  ...DESIGN_SECTIONS.map((section) => ({
    page: "design-system" as const,
    title: section.title,
    group: DESIGN_SYSTEM_GROUPS.find((group) => group.sections.includes(section))?.title,
    keywords: section.keywords,
  })),

  {
    page: "keybindings",
    title: "Reset all to defaults",
    keywords: "shortcuts keys",
  },
];

export type PhoneSettingsItem = PhoneSettingsEntry & { row: boolean };

const SEARCH_ITEMS: readonly PhoneSettingsItem[] = [
  ...(Object.keys(SETTINGS_PAGES) as SettingsRoute[]).map((route) => ({ page: route, title: SETTINGS_PAGES[route].title, row: false })),
  ...SETTINGS_INDEX.map((entry) => ({ ...entry, row: true })),
];

/**
 * The Settings pages and rows matching `query`, best first, as the Settings search and the Chats search list them. A page
 * of the connected Mac's settings counts only with one connected, and Keybindings only on an iPad, as on the list.
 */
export function searchPhoneSettings(query: string, shows: { connected: boolean; ipad: boolean }): SettingsSearchHit<PhoneSettingsItem>[] {
  const shown = (route: SettingsRoute) => {
    const needs: string | undefined = (SETTINGS_PAGES[route] as { needs?: string }).needs;
    return needs === "computer" ? shows.connected : needs === "ipad" ? shows.ipad : true;
  };
  return searchSettings(
    SEARCH_ITEMS.filter((item) => shown(item.page)),
    query,
    (route) => SETTINGS_PAGES[route].title,
  );
}
