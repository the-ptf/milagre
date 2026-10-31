import { AUTO_UPDATE_HINT, AUTO_UPDATE_TITLE } from "@milagre/shared/auto-update";
import { SIGN_INS_TITLE, SIGN_OUT } from "@milagre/shared/browser-sign-ins";
import { TOOL_CALL_DISPLAYS } from "@milagre/shared/chat-display";
import { DEVICE_NOTES_DESCRIPTION, DEVICE_NOTES_LABEL } from "@milagre/shared/device-notes";
import {
  LINEAR_ADD_WORKSPACE,
  LINEAR_ADD_WORKSPACE_HINT,
  LINEAR_HINT,
  LINEAR_MOVE_TO_STARTED_HINT,
  LINEAR_MOVE_TO_STARTED_TITLE,
  LINEAR_TITLE,
} from "@milagre/shared/linear";
import { MAIN_SYNC_HINT, MAIN_SYNC_TITLE } from "@milagre/shared/main-sync";
import type { SettingsSearchEntry } from "@milagre/shared/settings-search";
import type { SettingsSection } from "../components/Settings";
import { computerNoun } from "./shortcut-hints.ts";

export type DesktopSettingsEntry = SettingsSearchEntry<SettingsSection>;

/**
 * Every row a Settings section shows, in the order it shows them; each section's own name comes from the Settings nav.
 * `title` is the row's text exactly as on screen: the section opens with that row lit up. settings-index.test.ts checks
 * each one is still in the section's source.
 */
export const SETTINGS_INDEX: readonly DesktopSettingsEntry[] = [
  // General
  { page: "general", title: "Agents" },
  {
    page: "general",
    title: "Default model",
    group: "Agents",
    description: "Used for new chats; remembers your last selection",
    keywords: "model claude codex gpt",
  },
  {
    page: "general",
    title: "Default permission",
    group: "Agents",
    description: "Used for new chats; remembers your last selection",
    keywords: "approval ask auto full access mode",
  },
  { page: "general", title: "Sidebar" },
  {
    page: "general",
    title: "Chat order",
    group: "Sidebar",
    description: "Newest chat first keeps chats in place as replies arrive",
    keywords: "sort newest latest message recent",
  },
  { page: "general", title: "Editor" },
  { page: "general", title: "Open files in", group: "Editor", keywords: "cursor vscode zed editor ide" },
  { page: "general", title: "Worktrees" },
  { page: "general", title: MAIN_SYNC_TITLE, group: "Worktrees", description: MAIN_SYNC_HINT, keywords: "git pull fast-forward branch main" },
  { page: "general", title: "System" },
  {
    page: "general",
    title: `Keep the ${computerNoun} awake`,
    group: "System",
    description:
      "While Milagre runs, so your phone and other computers can reach it. The screen can still turn off. Plugged in, it stays awake with the lid closed; on battery, closing the lid sleeps it.",
    keywords: "sleep caffeinate lid",
  },
  { page: "general", title: "Plan usage" },
  { page: "general", title: "Show", group: "Plan usage", description: "Claude, Codex and Antigravity plan limits", keywords: "usage used remaining limits" },
  { page: "general", title: "Show in sidebar", group: "Plan usage", description: "Hover a provider for its limits and reset times", keywords: "usage limits" },

  // Usage
  { page: "usage", title: "Where it went", keywords: "cost tokens spend breakdown" },
  { page: "usage", title: "Models", keywords: "cost tokens spend" },
  { page: "usage", title: "Token mix", keywords: "input output cache tokens" },

  // Accounts
  { page: "accounts", title: "Add account", keywords: "sign in login provider claude codex antigravity" },
  { page: "accounts", title: "Usage limits" },
  {
    page: "accounts",
    title: "Switch accounts at usage limits",
    group: "Usage limits",
    description: "When a Chat hits its plan's usage limit, move its Project to the next signed-in account and continue.",
    keywords: "rate limit auto switch",
  },
  {
    page: "accounts",
    title: "Continue when the limit resets",
    group: "Usage limits",
    description: "When a Chat hits its plan's usage limit and no other account can take over, continue it at the reset time, up to a day later.",
    keywords: "resume rate limit wait",
  },

  // Project Accounts
  { page: "project-accounts", title: "Project or Link", keywords: "account choose which" },
  { page: "project-accounts", title: "Manage saved accounts", keywords: "accounts" },

  // Appearance
  {
    page: "appearance",
    title: "Mode",
    description: "System follows macOS. Every theme has a light and a dark version. ⌘⇧T switches.",
    keywords: "dark light system theme appearance",
  },
  { page: "appearance", title: "Catppuccin", keywords: "theme color palette" },
  { page: "appearance", title: "Popular", keywords: "theme color palette" },
  {
    page: "appearance",
    title: "Custom theme",
    description: 'Build a theme from a few colors. It shows up as "Custom" with the Milagre themes.',
    keywords: "colors palette own",
  },
  { page: "appearance", title: "Typography", keywords: "font text" },
  { page: "appearance", title: "Interface font", group: "Typography", description: "Used across the app.", keywords: "typeface text" },
  { page: "appearance", title: "Monospace font", group: "Typography", description: "Code, diffs and the terminal.", keywords: "code typeface" },
  { page: "appearance", title: "Sidebar size", group: "Typography", description: "Project and chat names in the sidebar.", keywords: "text font px" },
  { page: "appearance", title: "Chat size", group: "Typography", description: "Messages and the composer.", keywords: "text font px" },
  { page: "appearance", title: "Code size", group: "Typography", description: "Code blocks, diffs and the terminal.", keywords: "text font px" },
  { page: "appearance", title: "Layout" },
  {
    page: "appearance",
    title: "Chat width",
    group: "Layout",
    description: "How wide messages and the composer grow on large screens.",
    keywords: "wide narrow column",
  },
  {
    page: "appearance",
    title: "Provider icons",
    group: "Layout",
    description: "Original colors, or black and white to match the mode.",
    keywords: "logos monochrome",
  },
  {
    page: "appearance",
    title: "Sidebar usage",
    group: "Layout",
    description: "One row per provider, or provider icons in one line.",
    keywords: "limits compact",
  },
  { page: "appearance", title: "Diffs" },
  {
    page: "appearance",
    title: "Diff colors",
    group: "Diffs",
    description: "Additions and deletions, including change counts.",
    keywords: "green red additions deletions colorblind",
  },
  { page: "appearance", title: "Motion", keywords: "animation" },
  {
    page: "appearance",
    title: "Panel animations",
    group: "Motion",
    description: "How fast panels open and close. macOS Reduce Motion turns them off.",
    keywords: "motion speed reduce",
  },

  // Chat
  { page: "chat", title: "Context size beside Send", description: "Click it for usage and Compact now.", keywords: "context window tokens ring" },
  {
    page: "chat",
    title: "Auto compact quietly",
    description: "Compacts at your limit without context controls or notifications.",
    keywords: "compact context summarize",
  },
  {
    page: "chat",
    title: "Thresholds on this computer",
    description: "Drag either marker or enter a percentage. Auto compact waits for the reply to finish.",
    keywords: "compact context percent",
  },
  { page: "chat", title: "Reset to defaults", keywords: "thresholds compact context" },
  {
    page: "chat",
    title: "Show Compact below threshold",
    description: "Off by default. The button appears only at your threshold.",
    keywords: "compact button context",
  },
  { page: "chat", title: "Chat list", keywords: "sidebar layout" },
  { page: "chat", title: "One list", group: "Chat list", description: "Newest first, Project on each row." },
  { page: "chat", title: "By Project", group: "Chat list", description: "A group per Project that folds.", keywords: "grouped folders" },
  { page: "chat", title: "Done" },
  { page: "chat", title: "Archive Done chats after", group: "Done", keywords: "retention days hours cleanup" },
  { page: "chat", title: "Reasoning", keywords: "thinking" },
  { page: "chat", title: "Folded", group: "Reasoning", description: "Thinking stays in its row until you open it.", keywords: "collapse thinking" },
  { page: "chat", title: "Expanded", group: "Reasoning", description: "Thinking shows open above each answer.", keywords: "expand thinking" },
  { page: "chat", title: "Tool calls", keywords: "display detail" },
  ...TOOL_CALL_DISPLAYS.map(({ label, description }) => ({ page: "chat" as const, title: label, group: "Tool calls", description })),
  { page: "chat", title: "Replies" },
  {
    page: "chat",
    title: "TLDR writing",
    group: "Replies",
    description: "Shape Claude, Codex and Antigravity updates and replies with /tldr. Applies on the next turn after the current reply finishes.",
    keywords: "short concise summary",
  },
  { page: "chat", title: "Claude replies", group: "Replies", keywords: "concise normal length verbose" },
  { page: "chat", title: "Dictation", keywords: "voice speech microphone whisper" },
  { page: "chat", title: "When dictation finishes", group: "Dictation", keywords: "send insert voice" },
  {
    page: "chat",
    title: "Speech model",
    group: "Dictation",
    description: "Transcribes on this computer. Picking a model downloads it once.",
    keywords: "whisper download",
  },
  { page: "chat", title: "Language", group: "Dictation", keywords: "dictation voice english" },

  // Keybindings
  { page: "keybindings", title: "Add keybinding", keywords: "shortcut hotkey key" },
  { page: "keybindings", title: "Advanced" },
  {
    page: "keybindings",
    title: "Conditions",
    group: "Advanced",
    description: "Adds When to each keybinding, to run a key only in some places (for example not in a Terminal).",
    keywords: "when keybinding",
  },
  { page: "keybindings", title: "Reset all to defaults", keywords: "keys shortcuts restore" },

  // Browser
  { page: "browser", title: "Links" },
  {
    page: "browser",
    title: "Open links in",
    group: "Links",
    description: "Where web links open when you click them: links in the agent's replies and the servers the Chat runs.",
    keywords: "default browser external",
  },
  { page: "browser", title: SIGN_INS_TITLE, keywords: "logins cookies sessions" },
  { page: "browser", title: SIGN_OUT, group: SIGN_INS_TITLE, keywords: "log out logins cookies sessions" },

  // Notifications
  { page: "notifications", title: "Alerts" },
  {
    page: "notifications",
    title: "Notify when finished",
    group: "Alerts",
    description: "When a turn finishes or fails while you are outside the chat",
    keywords: "notification done",
  },
  {
    page: "notifications",
    title: "Dock badge",
    group: "Alerts",
    description: "Count chats with unread replies or waiting for your input",
    keywords: "unread count icon",
  },
  {
    page: "notifications",
    title: "Notify when waiting",
    group: "Alerts",
    description: "When a chat needs an approval or an answer and Milagre is in the background",
    keywords: "notification approval question",
  },
  {
    page: "notifications",
    title: "Attention button",
    group: "Alerts",
    description: "Top right, when a chat in another project needs an approval or an answer",
    keywords: "inbox approval",
  },
  { page: "notifications", title: "Schedule", keywords: "quiet hours do not disturb" },
  {
    page: "notifications",
    title: "Notification schedule",
    group: "Schedule",
    description: "Quiet outside these hours. Unread Chats stay in your inbox.",
    keywords: "quiet hours do not disturb weekdays",
  },
  { page: "notifications", title: "Sound", keywords: "chime audio" },
  {
    page: "notifications",
    title: "Notification chime",
    group: "Sound",
    description: "Plays when a Chat finishes or needs you. Picking one plays it.",
    keywords: "sound audio ding",
  },

  // Routines
  { page: "routines", title: "Nudges" },
  {
    page: "routines",
    title: "Unread Runs dot",
    group: "Nudges",
    description: "On the Routines button and each Routine's row, while a Run's Chat has a result you haven't opened",
    keywords: "unread badge",
  },

  // Connections
  { page: "connections", title: "Issue trackers" },
  { page: "connections", title: LINEAR_TITLE, group: "Issue trackers", description: LINEAR_HINT, keywords: "issues tickets" },
  {
    page: "connections",
    title: LINEAR_MOVE_TO_STARTED_TITLE,
    group: "Issue trackers",
    description: LINEAR_MOVE_TO_STARTED_HINT,
    keywords: "linear status started",
  },
  { page: "connections", title: LINEAR_ADD_WORKSPACE, group: "Issue trackers", description: LINEAR_ADD_WORKSPACE_HINT, keywords: "linear connect sign in" },

  // MCP
  { page: "mcp", title: "Add server", keywords: "tool server install connect" },

  // Milagre
  { page: "local-mcp", title: "Designs and artifacts" },
  {
    page: "local-mcp",
    title: "Published pages",
    group: "Designs and artifacts",
    description: "Manage public links to designs and artifacts, including pages from deleted Chats.",
    keywords: "share public links revoke",
  },
  { page: "local-mcp", title: "Milagre MCP", keywords: "clients claude desktop cursor" },
  { page: "local-mcp", title: "Custom MCP", group: "Milagre MCP", keywords: "connection token config" },
  { page: "local-mcp", title: "Create MCP config", group: "Milagre MCP", keywords: "connection token custom" },

  // Devices
  {
    page: "devices",
    title: "Allow devices to connect",
    keywords: "phone pair qr remote access",
  },
  { page: "devices", title: "Allow on local network", keywords: "lan wifi phone" },
  {
    page: "devices",
    title: "Connect through",
    description: "Automatic tries LAN and Tailscale before the remote connection. Private pairing needs both devices on the same network or tailnet.",
    keywords: "pairing route lan tailscale",
  },
  {
    page: "devices",
    title: "Scan with the Milagre app",
    description: "Open the app on your phone and point its camera at this code.",
    keywords: "qr pair phone",
  },
  { page: "devices", title: "Copy link", keywords: "pairing" },
  { page: "devices", title: "Allow pairing again", keywords: "pair new devices" },
  {
    page: "devices",
    title: "Drive other computers",
    description: "Drive the chats of other computers running Milagre from this window. Their Projects join the sidebar.",
    keywords: "remote pair mac",
  },
  {
    page: "devices",
    title: "Add computer",
    description: "Pair with another computer using the link from its Settings › Devices. The laptop button in the sidebar adds one too.",
    keywords: "pair mac remote",
  },
  { page: "devices", title: "Reset access", keywords: "new code revoke phones" },

  // Experimental
  { page: "experimental", title: "Beta" },
  {
    page: "experimental",
    title: "Floating inbox",
    group: "Beta",
    description:
      "A thin bar attached to the screen edge. Drag its grip to show docking targets over a dimmed desktop. Drop left, right, or bottom; release elsewhere to return. The bottom bar is horizontal. Hover a dot to preview its Chat.",
    keywords: "dock bar edge",
  },
  {
    page: "experimental",
    title: "Ultracode Fatality",
    group: "Beta",
    description: "Turning Ultracode on darkens the window, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud.",
    keywords: "mortal kombat sound",
  },
  { page: "experimental", title: "Bots", group: "Beta", description: "Named bots that work for you and ask before anything irreversible." },
  {
    page: "experimental",
    title: "Delegate to other computers",
    group: "Beta",
    description:
      "A Chat's agent can hand work to a Project on another paired computer. That computer runs the turn, and this Chat shows it as it runs. Needs Drive other computers on in Settings > Devices.",
    keywords: "remote agents",
  },
  { page: "experimental", title: DEVICE_NOTES_LABEL, group: "Beta", description: DEVICE_NOTES_DESCRIPTION, keywords: "phone tokens" },
  {
    page: "experimental",
    title: "Simlock devices",
    group: "Beta",
    description:
      "Agents lease a simulator or emulator of their own from a Simlock pool, watch it here and on the phone, and return it wiped. Simlock runs on your own Macs; Milagre doesn't install it.",
    keywords: "simulator emulator lease ios android",
  },
  {
    page: "experimental",
    title: "Computer use",
    group: "Beta",
    description: "Agents see and operate apps on this computer, asking before each new app.",
    keywords: "desktop apps control screen",
  },
  {
    page: "experimental",
    title: "Babysit PRs",
    group: "Beta",
    description: "Watch every PR a Chat opens and fix review comments, failed checks and conflicts.",
    keywords: "pull request review ci conflicts",
  },

  // About
  { page: "about", title: "Milagre" },
  { page: "about", title: "Version", group: "Milagre", keywords: "build release" },
  { page: "about", title: "Release channel", group: "Milagre", keywords: "stable beta" },
  { page: "about", title: "Updates", group: "Milagre", keywords: "update upgrade new version" },
  { page: "about", title: "Check for updates", group: "Milagre", keywords: "update upgrade new version" },
  { page: "about", title: AUTO_UPDATE_TITLE, group: "Milagre", description: AUTO_UPDATE_HINT, keywords: "install restart automatically" },
  { page: "about", title: "Runtime", group: "Milagre", keywords: "electron chromium" },
  { page: "about", title: "License", group: "Milagre", keywords: "mit" },
  { page: "about", title: "Privacy policy", group: "Milagre" },
  { page: "about", title: "Support", group: "Milagre", keywords: "help contact" },
];
