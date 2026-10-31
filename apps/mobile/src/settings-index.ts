import { AUTO_UPDATE_HINT, AUTO_UPDATE_TITLE } from "@milagre/shared/auto-update";
import { CHAT_LIST_TITLE } from "@milagre/shared/chat-display";
import { CHAT_ROW_FIELDS } from "@milagre/shared/chat-row";
import { DEVICE_NOTES_DESCRIPTION, DEVICE_NOTES_LABEL } from "@milagre/shared/device-notes";
import { LINEAR_HINT, LINEAR_MOVE_TO_STARTED_HINT, LINEAR_MOVE_TO_STARTED_TITLE, LINEAR_TITLE } from "@milagre/shared/linear";
import { MAIN_SYNC_HINT, MAIN_SYNC_TITLE } from "@milagre/shared/main-sync";
import type { SettingsSearchEntry } from "@milagre/shared/settings-search";

/**
 * The Settings pages the phone's search can open, by route, with the title each shows and what it needs: "computer" for
 * a page of the connected Mac's settings (hidden with none connected), "ipad" for one only an iPad shows.
 */
export const SETTINGS_PAGES = {
  computers: { title: "Computers" },
  routines: { title: "Routines", needs: "computer" },
  notifications: { title: "Notifications" },
  appearance: { title: "Appearance" },
  "browser-settings": { title: "Browser" },
  "chat-display": { title: "Chat" },
  "dictation-language": { title: "Dictation language" },
  "dictation-model": { title: "Speech model" },
  archived: { title: "Archived Chats" },
  experimental: { title: "Experimental" },
  "babysit-prs": { title: "Babysit PRs", needs: "computer" },
  simlock: { title: "Simlock devices", needs: "computer" },
  "computer-use": { title: "Computer use", needs: "computer" },
  general: { title: "General", needs: "computer" },
  usage: { title: "Plan usage", needs: "computer" },
  "token-usage": { title: "Token usage", needs: "computer" },
  accounts: { title: "Accounts", needs: "computer" },
  "project-accounts": { title: "Project Accounts", needs: "computer" },
  connections: { title: "Connections", needs: "computer" },
  skills: { title: "Skills", needs: "computer" },
  mcp: { title: "MCP", needs: "computer" },
  "local-mcp": { title: "Milagre", needs: "computer" },
  keybindings: { title: "Keybindings", needs: "ipad" },
} as const satisfies Record<string, { title: string; needs?: "computer" | "ipad" }>;

export type SettingsRoute = keyof typeof SETTINGS_PAGES;

export type PhoneSettingsEntry = SettingsSearchEntry<SettingsRoute>;

/**
 * Every row a Settings page shows, in the order it shows them; each page's own name is found through SETTINGS_PAGES.
 * `title` is the row's text exactly as on screen: the page opens with that row lit up. settings-index.test.ts checks
 * each one is still in the page's source.
 */
export const SETTINGS_INDEX: readonly PhoneSettingsEntry[] = [
  // Notifications
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
    title: "Attention button",
    description: "When a Chat in another Project needs an approval or an answer.",
    keywords: "inbox badge",
  },
  { page: "notifications", title: "Notification schedule", keywords: "quiet hours do not disturb weekdays work hours days" },
  {
    page: "notifications",
    title: "Notification chime",
    description: "Plays when a Chat finishes or needs you, on this phone. Picking one plays it.",
    keywords: "sound alert tone",
  },
  { page: "notifications", title: "Live Activities", keywords: "lock screen dynamic island show in live activities questions only" },

  // Appearance
  { page: "appearance", title: "Mode", keywords: "light dark system theme" },
  { page: "appearance", title: "Text size", group: "Text and motion", description: "Messages and the composer.", keywords: "font bigger smaller" },
  { page: "appearance", title: "Code size", group: "Text and motion", description: "Code blocks and diffs.", keywords: "font monospace" },
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
  { page: "appearance", title: "Custom theme", group: "Custom theme", description: "Build a theme from a few colors.", keywords: "colors palette" },
  { page: "appearance", title: "Editing", group: "Custom theme", keywords: "light dark custom theme colors" },

  // Browser
  {
    page: "browser-settings",
    title: "Open links in Milagre",
    group: "Browser on this device",
    description: "Open web links in this Chat's Browser. Turn off to use this device's default browser.",
    keywords: "web links safari in-app browser",
  },

  // Chat
  {
    page: "chat-display",
    title: "Show size beside Send",
    group: "Context size",
    description: "Tap for usage and Compact now.",
    keywords: "context window tokens usage",
  },
  { page: "chat-display", title: "Show below threshold", group: "Context size", keywords: "compact button always" },
  {
    page: "chat-display",
    title: "Auto compact quietly",
    group: "Context size",
    description: "Compacts at your limit. No context size, button or notifications.",
    keywords: "compact automatic threshold",
  },
  { page: "chat-display", title: CHAT_LIST_TITLE, group: CHAT_LIST_TITLE, keywords: "one list by project grouped sidebar" },
  // The phone never lists the Computer field: it is always on its rows.
  ...CHAT_ROW_FIELDS.filter((field) => field.id !== "computer").map((field) => ({
    page: "chat-display" as const,
    title: field.label,
    group: "Rows show",
    keywords: "chat list row",
  })),
  { page: "chat-display", title: "Reasoning", group: "Reasoning", keywords: "thinking folded expanded" },
  { page: "chat-display", title: "Tool calls", group: "Tool calls", keywords: "compact full detail" },
  { page: "chat-display", title: "When dictation finishes", group: "Dictation", keywords: "voice send insert mic" },

  // Experimental
  {
    page: "experimental",
    title: "Floating inbox",
    description: "A movable inbox button in the Chat. Tap to answer questions or approve requests. Flick it toward the left or right edge to tuck it away.",
    keywords: "button questions approvals",
  },
  {
    page: "experimental",
    title: "Show chat activity",
    description: "Include working chats with a progress summary and finished updates. Off: only questions and permission requests.",
    keywords: "floating inbox progress",
  },
  {
    page: "experimental",
    title: "Ultracode Fatality",
    description: "Turning Ultracode on darkens the screen, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud.",
    keywords: "mortal kombat announcer",
  },
  { page: "experimental", title: DEVICE_NOTES_LABEL, description: DEVICE_NOTES_DESCRIPTION, keywords: "sent from phone ipad tokens" },

  // Babysit PRs
  {
    page: "babysit-prs",
    title: "Babysit new PRs",
    group: "Babysit PRs",
    description: "Off by default. When a Chat opens a PR, Milagre adds a Heartbeat to that Chat and watches the PR until it's done.",
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
  { page: "babysit-prs", title: "The PR is merged or closed", group: "Stop babysitting when", description: "Always" },
  {
    page: "babysit-prs",
    title: "Checks pass and the PR is approved",
    group: "Stop babysitting when",
    description: "Nothing left to address. A comment that lands after this goes unwatched.",
    keywords: "green ci",
  },
  { page: "babysit-prs", title: "It has watched the PR for", group: "Stop babysitting when", keywords: "days timeout" },
  { page: "babysit-prs", title: "Watch the PR for", group: "Stop babysitting when", keywords: "days timeout" },
  { page: "babysit-prs", title: "It failed to fix the same problem", group: "Stop babysitting when", keywords: "times retries give up" },
  { page: "babysit-prs", title: "Failed to fix the same problem", group: "Stop babysitting when", keywords: "times retries give up" },
  {
    page: "babysit-prs",
    title: "Your own rule",
    group: "Stop babysitting when",
    description: "The agent checks it each time it wakes and ends the Heartbeat when it holds.",
    keywords: "custom condition instructions",
  },
  { page: "babysit-prs", title: "Reset all to defaults" },

  // Simlock devices
  {
    page: "simlock",
    title: "Devices at once",
    group: "Limits",
    description: "Leases this Mac holds together. Simlock also caps leases per token.",
    keywords: "simulators emulators leases pool",
  },
  {
    page: "simlock",
    title: "Return a device after",
    group: "Limits",
    description: "A lease ends this long after it started, even while an agent uses it.",
    keywords: "lease minutes hours timeout",
  },

  // Computer use
  {
    page: "computer-use",
    title: "Show the agent's cursor",
    keywords: "pointer overlay screen",
  },
  { page: "computer-use", title: "Accessibility", group: "Permissions on the Mac", keywords: "grant permission system settings" },
  { page: "computer-use", title: "Screen Recording", group: "Permissions on the Mac", keywords: "grant permission system settings" },

  // General
  {
    page: "general",
    title: MAIN_SYNC_TITLE,
    group: "Worktrees",
    description: MAIN_SYNC_HINT,
    keywords: "git pull fast-forward main branch remote",
  },
  {
    page: "general",
    title: AUTO_UPDATE_TITLE,
    group: "Updates",
    description: AUTO_UPDATE_HINT,
    keywords: "install restart upgrade version",
  },

  // Token usage
  { page: "token-usage", title: "Period", keywords: "range days week month" },
  { page: "token-usage", title: "Show", keywords: "cost tokens metric" },

  // Accounts
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

  // Connections
  { page: "connections", title: LINEAR_TITLE, group: "Issue trackers", description: LINEAR_HINT, keywords: "issues tracker" },
  {
    page: "connections",
    title: LINEAR_MOVE_TO_STARTED_TITLE,
    group: "Issue trackers",
    description: LINEAR_MOVE_TO_STARTED_HINT,
    keywords: "linear status started",
  },

  // Milagre
  {
    page: "local-mcp",
    title: "Published pages",
    group: "Designs and artifacts",
    description: "Public links to designs and artifacts.",
    keywords: "share links",
  },
  { page: "local-mcp", title: "Custom MCP", group: "Milagre MCP", keywords: "connection token access config" },

  // Keybindings
  { page: "keybindings", title: "Reset all to defaults", keywords: "shortcuts keys" },
];
