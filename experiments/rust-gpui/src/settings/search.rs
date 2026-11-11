//! Settings search index and ranker (ported from `packages/shared/src/settings-search.ts` and
//! `apps/desktop/app/src/lib/settings-index.ts`).

use crate::ui::IconName;

/// A Settings section identifier, matching `SettingsSection` in `components/Settings.tsx`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SettingsSectionId {
    General,
    Appearance,
    Chat,
    Voice,
    Notifications,
    Keybindings,
    Models,
    Accounts,
    Usage,
    Skills,
    Mcp,
    Browser,
    Worktrees,
    Connections,
    Devices,
    ThisMac,
    Computer,
    Project,
    Experimental,
    About,
}

impl SettingsSectionId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Appearance => "appearance",
            Self::Chat => "chat",
            Self::Voice => "voice",
            Self::Notifications => "notifications",
            Self::Keybindings => "keybindings",
            Self::Models => "models",
            Self::Accounts => "accounts",
            Self::Usage => "usage",
            Self::Skills => "skills",
            Self::Mcp => "mcp",
            Self::Browser => "browser",
            Self::Worktrees => "worktrees",
            Self::Connections => "connections",
            Self::Devices => "devices",
            Self::ThisMac => "this-mac",
            Self::Computer => "computer",
            Self::Project => "project",
            Self::Experimental => "experimental",
            Self::About => "about",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "general" => Some(Self::General),
            "appearance" => Some(Self::Appearance),
            "chat" => Some(Self::Chat),
            "voice" => Some(Self::Voice),
            "notifications" => Some(Self::Notifications),
            "keybindings" => Some(Self::Keybindings),
            "models" => Some(Self::Models),
            "accounts" => Some(Self::Accounts),
            "usage" => Some(Self::Usage),
            "skills" => Some(Self::Skills),
            "mcp" => Some(Self::Mcp),
            "browser" => Some(Self::Browser),
            "worktrees" => Some(Self::Worktrees),
            "connections" => Some(Self::Connections),
            "devices" => Some(Self::Devices),
            "this-mac" => Some(Self::ThisMac),
            "computer" => Some(Self::Computer),
            "project" => Some(Self::Project),
            "experimental" | "church" => Some(Self::Experimental),
            "about" => Some(Self::About),
            _ => None,
        }
    }

    /// A Settings section's name, as `SECTION_TITLES` in `settings-index.ts` defines it.
    pub const fn title(self) -> &'static str {
        match self {
            Self::General => "General",
            Self::Appearance => "Appearance",
            Self::Chat => "Chat",
            Self::Voice => "Voice",
            Self::Notifications => "Notifications",
            Self::Keybindings => "Keybindings",
            Self::Models => "Models",
            Self::Accounts => "Accounts",
            Self::Usage => "Usage",
            Self::Skills => "Skills",
            Self::Mcp => "MCP servers",
            Self::Browser => "Browser",
            Self::Worktrees => "Worktrees",
            Self::Connections => "Integrations",
            Self::Devices => "Phone & sharing",
            Self::ThisMac => "This Mac",
            Self::Computer => "Computer",
            Self::Project => "Project",
            Self::Experimental => "Church",
            Self::About => "About",
        }
    }

    /// Other words for a section (`SECTION_KEYWORDS` in `settings-index.ts`), so search finds it by what it holds.
    pub const fn keywords(self) -> &'static str {
        match self {
            Self::General => "editor sidebar chat order chat list done archive plan usage keep awake",
            Self::Worktrees => "main branch sync pull fast-forward storage clean up cleanup disk idle",
            Self::ThisMac => "computer resources memory disk drive other computers add computer computer use",
            Self::Usage => "token tokens cost spend dollars analytics estimated",
            Self::Accounts => "sign in login claude codex antigravity profile per project link usage limits",
            Self::Appearance => "theme dark light mode font size colors look",
            Self::Chat => "messages transcript reasoning tool calls follow-up queue steer",
            Self::Voice => "dictation speech whisper microphone language transcribe",
            Self::Models => "default model permission mode compact context replies tldr concise",
            Self::Keybindings => "shortcuts keyboard keys hotkeys",
            Self::Browser => "links web sign-ins cookies",
            Self::Notifications => "alerts sounds chimes push routines unread runs",
            Self::Connections => "linear issues integrations babysit pull requests",
            Self::Mcp => "servers tools model context protocol milagre mcp",
            Self::Devices => "phone pairing computers remote qr published pages share simlock simulators reset access",
            Self::Experimental => "church experimental beta labs",
            Self::About => "version update privacy support",
            Self::Skills | Self::Computer | Self::Project => "",
        }
    }

    /// The Hugeicons glyph for this section in the nav and search results.
    pub const fn icon(self) -> IconName {
        match self {
            Self::General => IconName::Settings01,
            Self::Appearance => IconName::PaintBoard,
            Self::Chat => IconName::BubbleChat,
            Self::Voice => IconName::Mic01,
            Self::Notifications => IconName::Notification01,
            Self::Keybindings => IconName::Keyboard,
            Self::Models => IconName::AiBrain01,
            Self::Accounts => IconName::UserCircle,
            Self::Usage => IconName::ChartColumn,
            Self::Skills => IconName::BookOpen01,
            Self::Mcp => IconName::Plug01,
            Self::Browser => IconName::Globe02,
            Self::Worktrees => IconName::FolderTree,
            Self::Connections => IconName::Connect,
            Self::Devices => IconName::Smartphone,
            Self::ThisMac => IconName::Laptop,
            Self::Computer => IconName::Computer,
            Self::Project => IconName::Folder01,
            Self::Experimental => IconName::Church,
            Self::About => IconName::InformationCircle,
        }
    }

    /// Whether WP-39 implements this section's body (`None`) or shows a placeholder naming the package (`Some`).
    pub const fn placeholder_package(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::General | Self::Chat | Self::Notifications | Self::Models | Self::Browser | Self::Experimental | Self::About => None,
            Self::Appearance => Some(("WP-40", "Appearance Settings")),
            Self::Voice => Some(("WP-41", "Voice Settings")),
            Self::Keybindings => Some(("WP-41", "Keybindings Settings")),
            Self::Accounts => Some(("WP-42", "Accounts Settings")),
            Self::Usage => Some(("WP-42", "Usage Settings")),
            Self::Skills => Some(("WP-43", "Skills Settings")),
            Self::Mcp => Some(("WP-43", "MCP Servers Settings")),
            Self::Connections => Some(("WP-43", "Integrations Settings")),
            Self::Worktrees => Some(("WP-44", "Worktrees Settings")),
            Self::Devices => Some(("WP-44", "Phone & Sharing Settings")),
            Self::ThisMac => Some(("WP-44", "This Mac Settings")),
            Self::Computer => Some(("WP-44", "Computer Settings")),
            Self::Project => Some(("WP-44", "Project Settings")),
        }
    }
}

/// All static sections in the order `ALL_SECTIONS` in `Settings.tsx` lists them for search.
pub const ALL_SECTIONS: &[SettingsSectionId] = &[
    SettingsSectionId::General,
    SettingsSectionId::Appearance,
    SettingsSectionId::Chat,
    SettingsSectionId::Voice,
    SettingsSectionId::Notifications,
    SettingsSectionId::Keybindings,
    SettingsSectionId::Models,
    SettingsSectionId::Accounts,
    SettingsSectionId::Usage,
    SettingsSectionId::Skills,
    SettingsSectionId::Mcp,
    SettingsSectionId::Browser,
    SettingsSectionId::Worktrees,
    SettingsSectionId::Connections,
    SettingsSectionId::Devices,
    SettingsSectionId::ThisMac,
    SettingsSectionId::Experimental,
    SettingsSectionId::About,
];

/// One thing Settings can find: a page, a computer, a project, or a row on a page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsSearchEntry {
    pub page: SettingsSectionId,
    pub title: String,
    pub group: Option<String>,
    pub description: Option<String>,
    pub keywords: Option<String>,
    /// When `page` is `Computer` or `Project`, the target computer id or project path.
    pub target_id: Option<String>,
    /// When `page` is `Computer`, whether it is connected.
    pub connected: Option<bool>,
}

impl SettingsSearchEntry {
    pub fn row(
        page: SettingsSectionId,
        title: &'static str,
        group: Option<&'static str>,
        description: Option<&'static str>,
        keywords: Option<&'static str>,
    ) -> Self {
        Self {
            page,
            title: title.to_string(),
            group: group.map(str::to_string),
            description: description.map(str::to_string),
            keywords: keywords.map(str::to_string),
            target_id: None,
            connected: None,
        }
    }
}

/// A ranked search hit and the character `[start, end)` ranges of `entry.title` that matched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsSearchHit {
    pub entry: SettingsSearchEntry,
    pub ranges: Vec<(usize, usize)>,
}

/// Static row index entry from `apps/desktop/app/src/lib/settings-index.ts`.
#[derive(Clone, Copy, Debug)]
pub struct StaticSettingsEntry {
    pub page: SettingsSectionId,
    pub title: &'static str,
    pub group: Option<&'static str>,
    pub description: Option<&'static str>,
    pub keywords: Option<&'static str>,
}

impl StaticSettingsEntry {
    pub fn to_entry(self) -> SettingsSearchEntry {
        SettingsSearchEntry::row(self.page, self.title, self.group, self.description, self.keywords)
    }
}

/// Every row a Settings section shows, in the exact order of `SETTINGS_INDEX` in `settings-index.ts`.
pub const SETTINGS_INDEX: &[StaticSettingsEntry] = &[
    // General
    StaticSettingsEntry { page: SettingsSectionId::General, title: "Editor", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::General,
        title: "Open files in",
        group: Some("Editor"),
        description: None,
        keywords: Some("cursor vscode zed editor ide"),
    },
    StaticSettingsEntry { page: SettingsSectionId::General, title: "Sidebar", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::General,
        title: "Chat order",
        group: Some("Sidebar"),
        description: Some("Newest Chat first keeps chats in place as replies arrive"),
        keywords: Some("sort newest latest message recent"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::General,
        title: "Chat list",
        group: None,
        description: None,
        keywords: Some("sidebar layout"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::General,
        title: "One list",
        group: Some("Chat list"),
        description: Some("Newest first, Project on each row."),
        keywords: None,
    },
    StaticSettingsEntry {
        page: SettingsSectionId::General,
        title: "By Project",
        group: Some("Chat list"),
        description: Some("A group per Project that folds."),
        keywords: Some("grouped folders"),
    },
    StaticSettingsEntry { page: SettingsSectionId::General, title: "Done", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::General,
        title: "Archive Done Chats after",
        group: Some("Done"),
        description: None,
        keywords: Some("retention days hours cleanup"),
    },
    StaticSettingsEntry { page: SettingsSectionId::General, title: "Plan usage", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::General,
        title: "Show",
        group: Some("Plan usage"),
        description: Some("Claude, Codex and Antigravity plan limits"),
        keywords: Some("usage used remaining limits"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::General,
        title: "Show in sidebar",
        group: Some("Plan usage"),
        description: Some("Hover a provider for its limits and reset times"),
        keywords: Some("usage limits"),
    },
    StaticSettingsEntry { page: SettingsSectionId::General, title: "System", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::General,
        title: "Keep the Mac awake",
        group: Some("System"),
        description: Some(
            "While Milagre runs, so your phone and other computers can reach it. The screen can still turn off. Plugged in, it stays awake with the lid closed; on battery, closing the lid sleeps it.",
        ),
        keywords: Some("sleep caffeinate lid"),
    },
    // Appearance
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Mode",
        group: None,
        description: Some("System follows macOS. Every theme has a light and a dark version. ⇧⌘T switches."),
        keywords: Some("dark light system theme appearance"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Catppuccin",
        group: None,
        description: None,
        keywords: Some("theme color palette"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Popular",
        group: None,
        description: None,
        keywords: Some("theme color palette"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Custom theme",
        group: None,
        description: Some("Build a theme from a few colors. It shows up as \"Custom\" with the Milagre themes."),
        keywords: Some("colors palette own"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Typography",
        group: None,
        description: None,
        keywords: Some("font text"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Interface font",
        group: Some("Typography"),
        description: Some("Used across the app."),
        keywords: Some("typeface text"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Monospace font",
        group: Some("Typography"),
        description: Some("Code, diffs and the terminal."),
        keywords: Some("code typeface"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Sidebar size",
        group: Some("Typography"),
        description: Some("Project and chat names in the sidebar."),
        keywords: Some("text font px"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Chat size",
        group: Some("Typography"),
        description: Some("Messages and the composer."),
        keywords: Some("text font px"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Code size",
        group: Some("Typography"),
        description: Some("Code blocks, diffs and the terminal."),
        keywords: Some("text font px"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Appearance, title: "Layout", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Chat width",
        group: Some("Layout"),
        description: Some("How wide messages and the composer grow on large screens."),
        keywords: Some("wide narrow column"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Provider icons",
        group: Some("Layout"),
        description: Some("Original colors, or black and white to match the mode."),
        keywords: Some("logos monochrome"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Sidebar usage",
        group: Some("Layout"),
        description: Some("One row per provider, or provider icons in one line."),
        keywords: Some("limits compact"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Appearance, title: "Diffs", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Diff colors",
        group: Some("Diffs"),
        description: Some("Additions and deletions, including change counts."),
        keywords: Some("green red additions deletions colorblind"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Motion",
        group: None,
        description: None,
        keywords: Some("animation"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Appearance,
        title: "Panel animations",
        group: Some("Motion"),
        description: Some("How fast panels open and close. macOS Reduce Motion turns them off."),
        keywords: Some("motion speed reduce"),
    },
    // Chat
    StaticSettingsEntry {
        page: SettingsSectionId::Chat,
        title: "Messages during a turn",
        group: None,
        description: None,
        keywords: Some("steer queue follow-up send now later while running"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Chat,
        title: "While the agent works",
        group: Some("Messages during a turn"),
        description: Some("Send now steers the running turn; Queue waits for it to end."),
        keywords: Some("steer queue follow-up send now later"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Chat, title: "Reasoning", group: None, description: None, keywords: Some("thinking") },
    StaticSettingsEntry {
        page: SettingsSectionId::Chat,
        title: "Folded",
        group: Some("Reasoning"),
        description: Some("Thinking stays in its row until you open it."),
        keywords: Some("collapse thinking"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Chat,
        title: "Expanded",
        group: Some("Reasoning"),
        description: Some("Thinking shows open above each answer."),
        keywords: Some("expand thinking"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Chat,
        title: "Tool calls",
        group: None,
        description: None,
        keywords: Some("display detail"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Chat,
        title: "Compact",
        group: Some("Tool calls"),
        description: Some("One line per reply."),
        keywords: None,
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Chat,
        title: "Full detail",
        group: Some("Tool calls"),
        description: Some("Each call on its own row."),
        keywords: None,
    },
    // Voice
    StaticSettingsEntry {
        page: SettingsSectionId::Voice,
        title: "Dictation",
        group: None,
        description: None,
        keywords: Some("voice speech microphone whisper"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Voice,
        title: "Shortcut",
        group: Some("Dictation"),
        description: None,
        keywords: Some("dictate voice keyboard alt space hold"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Voice,
        title: "How the shortcut works",
        group: Some("Dictation"),
        description: None,
        keywords: Some("hold press toggle start stop"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Voice,
        title: "Fix-up model",
        group: Some("Dictation"),
        description: None,
        keywords: Some("correction automatic haiku codex gemini kiro"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Voice,
        title: "Fix names with AI",
        group: Some("Dictation"),
        description: None,
        keywords: Some("post processing correction automatic model haiku codex gemini kiro"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Voice,
        title: "When dictation finishes",
        group: Some("Dictation"),
        description: None,
        keywords: Some("send insert voice"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Voice,
        title: "Speech model",
        group: Some("Dictation"),
        description: Some("Transcribes on this computer. Picking a model downloads it once."),
        keywords: Some("whisper download"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Voice,
        title: "Language",
        group: Some("Dictation"),
        description: None,
        keywords: Some("dictation voice english"),
    },
    // Notifications
    StaticSettingsEntry { page: SettingsSectionId::Notifications, title: "Alerts", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Notifications,
        title: "Notify when finished",
        group: Some("Alerts"),
        description: Some("When a turn finishes or fails while you are outside the chat"),
        keywords: Some("notification done"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Notifications,
        title: "Dock badge",
        group: Some("Alerts"),
        description: Some("Count chats with unread replies or waiting for your input"),
        keywords: Some("unread count icon"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Notifications,
        title: "Notify when waiting",
        group: Some("Alerts"),
        description: Some("When a chat needs an approval or an answer and Milagre is in the background"),
        keywords: Some("notification approval question"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Notifications,
        title: "Attention button",
        group: Some("Alerts"),
        description: Some("Top right, when a chat in another project needs an approval or an answer"),
        keywords: Some("inbox approval"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Notifications,
        title: "Schedule",
        group: None,
        description: None,
        keywords: Some("quiet hours do not disturb"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Notifications,
        title: "Notification schedule",
        group: Some("Schedule"),
        description: Some("Quiet outside these hours. Unread Chats stay in your inbox."),
        keywords: Some("quiet hours do not disturb weekdays"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Notifications,
        title: "Sound",
        group: None,
        description: None,
        keywords: Some("chime audio"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Notifications,
        title: "Notification chime",
        group: Some("Sound"),
        description: Some("Plays when a Chat finishes or needs you. Picking one plays it."),
        keywords: Some("sound audio ding"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Notifications, title: "Routines", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Notifications,
        title: "Unread Runs dot",
        group: Some("Routines"),
        description: Some("On the Routines button and each Routine's row, while a Run's Chat has a result you haven't opened"),
        keywords: Some("unread badge"),
    },
    // Keybindings
    StaticSettingsEntry {
        page: SettingsSectionId::Keybindings,
        title: "Add keybinding",
        group: None,
        description: None,
        keywords: Some("shortcut hotkey key"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Keybindings, title: "Advanced", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Keybindings,
        title: "Conditions",
        group: Some("Advanced"),
        description: Some("Adds When to each keybinding, to run a key only in some places (for example not in a Terminal)."),
        keywords: Some("when keybinding"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Keybindings,
        title: "Reset all to defaults",
        group: None,
        description: None,
        keywords: Some("keys shortcuts restore"),
    },
    // Models
    StaticSettingsEntry { page: SettingsSectionId::Models, title: "New chats", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "Default model",
        group: Some("New chats"),
        description: Some("Used for new chats; remembers your last selection"),
        keywords: Some("model claude codex gpt"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "Default permission",
        group: Some("New chats"),
        description: Some("Used for new chats; remembers your last selection"),
        keywords: Some("approval ask auto full access mode"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "Context",
        group: None,
        description: None,
        keywords: Some("compact context window tokens"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "Context size beside Send",
        group: Some("Context"),
        description: Some("Click it for usage and Compact now."),
        keywords: Some("context window tokens ring"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "Auto compact quietly",
        group: Some("Context"),
        description: Some("Compacts at your limit without context controls or notifications."),
        keywords: Some("compact context summarize"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "Thresholds on this computer",
        group: Some("Context"),
        description: Some("Drag either marker or enter a percentage. Auto compact waits for the reply to finish."),
        keywords: Some("compact context percent"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "Reset to defaults",
        group: Some("Context"),
        description: None,
        keywords: Some("thresholds compact context"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "Show Compact below threshold",
        group: Some("Context"),
        description: Some("Off by default. The button appears only at your threshold."),
        keywords: Some("compact button context"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Models, title: "Replies", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "TLDR writing",
        group: Some("Replies"),
        description: Some(
            "Shape Claude, Codex and Antigravity updates and replies with /tldr. Applies on the next turn after the current reply finishes.",
        ),
        keywords: Some("short concise summary"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Models,
        title: "Claude replies",
        group: Some("Replies"),
        description: None,
        keywords: Some("concise normal length verbose"),
    },
    // Accounts
    StaticSettingsEntry {
        page: SettingsSectionId::Accounts,
        title: "Add account",
        group: None,
        description: None,
        keywords: Some("sign in login provider claude codex antigravity"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Accounts, title: "Usage limits", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Accounts,
        title: "Switch accounts at usage limits",
        group: Some("Usage limits"),
        description: Some("When a Chat hits its plan's usage limit, move its Project to the next signed-in account and continue."),
        keywords: Some("rate limit auto switch"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Accounts,
        title: "Continue when the limit resets",
        group: Some("Usage limits"),
        description: Some(
            "When a Chat hits its plan's usage limit and no other account can take over, continue it at the reset time, up to a day later.",
        ),
        keywords: Some("resume rate limit wait"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Accounts, title: "Per Project", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Accounts,
        title: "Project or Link",
        group: Some("Per Project"),
        description: None,
        keywords: Some("account choose which"),
    },
    // Usage
    StaticSettingsEntry {
        page: SettingsSectionId::Usage,
        title: "Where it went",
        group: None,
        description: None,
        keywords: Some("cost tokens spend breakdown"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Usage,
        title: "Models",
        group: None,
        description: None,
        keywords: Some("cost tokens spend"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Usage,
        title: "Token mix",
        group: None,
        description: None,
        keywords: Some("input output cache tokens"),
    },
    // MCP servers
    StaticSettingsEntry {
        page: SettingsSectionId::Mcp,
        title: "Add server",
        group: None,
        description: None,
        keywords: Some("tool server install connect"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Mcp,
        title: "Milagre MCP",
        group: None,
        description: None,
        keywords: Some("clients claude desktop cursor"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Mcp,
        title: "Custom MCP",
        group: Some("Milagre MCP"),
        description: None,
        keywords: Some("connection token config"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Mcp,
        title: "Create MCP config",
        group: Some("Milagre MCP"),
        description: None,
        keywords: Some("connection token custom"),
    },
    // Browser
    StaticSettingsEntry { page: SettingsSectionId::Browser, title: "Links", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Browser,
        title: "Open links in",
        group: Some("Links"),
        description: Some("Where web links open when you click them: links in the agent's replies and the servers the Chat runs."),
        keywords: Some("default browser external"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Browser,
        title: "Sign-ins",
        group: None,
        description: None,
        keywords: Some("logins cookies sessions"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Browser,
        title: "Sign out",
        group: Some("Sign-ins"),
        description: None,
        keywords: Some("log out logins cookies sessions"),
    },
    // Worktrees
    StaticSettingsEntry { page: SettingsSectionId::Worktrees, title: "Main branch", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Worktrees,
        title: "Sync source branch before new Worktrees",
        group: Some("Main branch"),
        description: Some("Fast-forwards the source branch from its remote. Skipped when it has local changes or commits."),
        keywords: Some("git pull fast-forward branch main"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Worktrees, title: "Storage", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Worktrees,
        title: "Clean up worktrees",
        group: Some("Storage"),
        description: Some("Worktrees Milagre made that no Chat has used for a while. Their Chats are deleted with them."),
        keywords: Some("storage disk space free worktrees delete old idle"),
    },
    // Integrations
    StaticSettingsEntry { page: SettingsSectionId::Connections, title: "Issue trackers", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Connections,
        title: "Linear",
        group: Some("Issue trackers"),
        description: Some("Start chats from Linear issues and see each Worktree's issue."),
        keywords: Some("issues tickets"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Connections,
        title: "Move issues to In Progress",
        group: Some("Issue trackers"),
        description: Some("When a chat starts from an issue that hasn't started yet, move it to its team's first started status."),
        keywords: Some("linear status started"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Connections,
        title: "Add workspace",
        group: Some("Issue trackers"),
        description: Some(
            "Opens a Linear sign-in of its own, so you can use another account. Signing in to a workspace already here signs it in again.",
        ),
        keywords: Some("linear connect sign in"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Connections, title: "Pull requests", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Connections,
        title: "Babysit PRs",
        group: Some("Pull requests"),
        description: Some("Watch every PR a Chat opens and fix review comments, failed checks and conflicts."),
        keywords: Some("pull request review ci conflicts"),
    },
    // Phone & sharing
    StaticSettingsEntry {
        page: SettingsSectionId::Devices,
        title: "Allow devices to connect",
        group: None,
        description: None,
        keywords: Some("phone pair qr remote access"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Devices,
        title: "Allow on local network",
        group: None,
        description: None,
        keywords: Some("lan wifi phone"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Devices,
        title: "Connect through",
        group: None,
        description: Some(
            "Automatic tries LAN and Tailscale before the remote connection. Private pairing needs both devices on the same network or tailnet.",
        ),
        keywords: Some("pairing route lan tailscale"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Devices,
        title: "Scan with the Milagre app",
        group: None,
        description: Some("Open the app on your phone and point its camera at this code."),
        keywords: Some("qr pair phone"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Devices, title: "Copy link", group: None, description: None, keywords: Some("pairing") },
    StaticSettingsEntry {
        page: SettingsSectionId::Devices,
        title: "Allow pairing again",
        group: None,
        description: None,
        keywords: Some("pair new devices"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Devices,
        title: "Reset access",
        group: None,
        description: None,
        keywords: Some("new code revoke phones"),
    },
    StaticSettingsEntry { page: SettingsSectionId::Devices, title: "Simulators", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Devices,
        title: "Simlock devices",
        group: Some("Simulators"),
        description: Some(
            "Agents lease a simulator or emulator of their own from a Simlock pool, watch it here and on the phone, and return it wiped. Simlock runs on your own Macs; Milagre doesn't install it.",
        ),
        keywords: Some("simulator emulator lease ios android"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Devices,
        title: "Designs and artifacts",
        group: None,
        description: None,
        keywords: None,
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Devices,
        title: "Published pages",
        group: Some("Designs and artifacts"),
        description: Some("Manage public links to designs and artifacts, including pages from deleted Chats."),
        keywords: Some("share public links revoke"),
    },
    // This Mac
    StaticSettingsEntry {
        page: SettingsSectionId::ThisMac,
        title: "Drive other computers",
        group: None,
        description: Some("Drive the chats of other computers running Milagre from this window. Their Projects join the sidebar."),
        keywords: Some("remote pair mac"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::ThisMac,
        title: "Add computer",
        group: None,
        description: Some(
            "Pair with another computer using the link from its Settings › Phone & sharing. The laptop button in the sidebar adds one too.",
        ),
        keywords: Some("pair mac remote"),
    },
    StaticSettingsEntry { page: SettingsSectionId::ThisMac, title: "Automation", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::ThisMac,
        title: "Computer use",
        group: Some("Automation"),
        description: Some("Agents see and operate apps on this computer, asking before each new app."),
        keywords: Some("desktop apps control screen"),
    },
    // Church
    StaticSettingsEntry { page: SettingsSectionId::Experimental, title: "Beta", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::Experimental,
        title: "Floating inbox",
        group: Some("Beta"),
        description: Some(
            "A thin bar attached to the screen edge. Drag its grip to show docking targets over a dimmed desktop. Drop left, right, or bottom; release elsewhere to return. The bottom bar is horizontal. Hover a dot to preview its Chat.",
        ),
        keywords: Some("dock bar edge"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Experimental,
        title: "Ultracode Fatality",
        group: Some("Beta"),
        description: Some(
            "Turning Ultracode on darkens the window, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud.",
        ),
        keywords: Some("mortal kombat sound"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Experimental,
        title: "New Chat stats",
        group: Some("Beta"),
        description: Some("Open pull requests, plan usage and today's tokens on a new Chat."),
        keywords: Some("glance cards pull requests usage tokens"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Experimental,
        title: "Delegate to other computers",
        group: Some("Beta"),
        description: Some(
            "A Chat's agent can hand work to a Project on another paired computer. That computer runs the turn, and this Chat shows it as it runs. Needs Drive other computers on in Settings > Devices.",
        ),
        keywords: Some("remote agents"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::Experimental,
        title: "Device notes",
        group: Some("Beta"),
        description: Some(
            "Tell a Chat's agent when you write from your phone, iPad or another computer, so it doesn't ask you to open files or apps on the Mac.",
        ),
        keywords: Some("phone tokens"),
    },
    // About
    StaticSettingsEntry { page: SettingsSectionId::About, title: "Milagre", group: None, description: None, keywords: None },
    StaticSettingsEntry {
        page: SettingsSectionId::About,
        title: "Version",
        group: Some("Milagre"),
        description: None,
        keywords: Some("build release"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::About,
        title: "Release channel",
        group: Some("Milagre"),
        description: None,
        keywords: Some("stable beta"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::About,
        title: "Updates",
        group: Some("Milagre"),
        description: None,
        keywords: Some("update upgrade new version"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::About,
        title: "Check for updates",
        group: Some("Milagre"),
        description: None,
        keywords: Some("update upgrade new version"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::About,
        title: "Auto update",
        group: Some("Milagre"),
        description: Some(
            "Installs a downloaded update by itself once no Chat or Routine is running and nobody has used the Mac for 5 minutes. For a Mac nobody watches, like a server.",
        ),
        keywords: Some("install restart automatically"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::About,
        title: "Runtime",
        group: Some("Milagre"),
        description: None,
        keywords: Some("electron chromium"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::About,
        title: "License",
        group: Some("Milagre"),
        description: None,
        keywords: Some("mit"),
    },
    StaticSettingsEntry {
        page: SettingsSectionId::About,
        title: "Privacy policy",
        group: Some("Milagre"),
        description: None,
        keywords: None,
    },
    StaticSettingsEntry {
        page: SettingsSectionId::About,
        title: "Support",
        group: Some("Milagre"),
        description: None,
        keywords: Some("help contact"),
    },
];

/// Builds the full searchable entries list, matching `entries` in `SettingsNav` (`Settings.tsx`):
/// all static sections first, then paired computers, then recent Projects, then `SETTINGS_INDEX`.
pub fn build_search_entries(
    this_mac_name: Option<&str>,
    computers: &[(String, String, bool)],
    projects: &[(String, String)],
) -> Vec<SettingsSearchEntry> {
    let mut out = Vec::with_capacity(ALL_SECTIONS.len() + computers.len() + projects.len() + SETTINGS_INDEX.len());
    for &section in ALL_SECTIONS {
        let keywords = match section {
            SettingsSectionId::ThisMac => {
                let base = section.keywords();
                match this_mac_name.filter(|s| !s.is_empty()) {
                    Some(name) => format!("{base} {name}"),
                    None => base.to_string(),
                }
            }
            _ => section.keywords().to_string(),
        };
        out.push(SettingsSearchEntry {
            page: section,
            title: section.title().to_string(),
            group: None,
            description: None,
            keywords: (!keywords.is_empty()).then_some(keywords),
            target_id: None,
            connected: None,
        });
    }
    for (id, name, connected) in computers {
        out.push(SettingsSearchEntry {
            page: SettingsSectionId::Computer,
            title: name.clone(),
            group: Some("Computers & devices".to_string()),
            description: None,
            keywords: Some("computer remote mac".to_string()),
            target_id: Some(id.clone()),
            connected: Some(*connected),
        });
    }
    for (path, name) in projects {
        out.push(SettingsSearchEntry {
            page: SettingsSectionId::Project,
            title: name.clone(),
            group: Some("Projects".to_string()),
            description: Some(path.clone()),
            keywords: Some("project setup command instructions".to_string()),
            target_id: Some(path.clone()),
            connected: None,
        });
    }
    for entry in SETTINGS_INDEX {
        out.push(entry.to_entry());
    }
    out
}

/// Folds a single Unicode character to its lowercase ASCII base when it is a Latin character with diacritics,
/// matching `text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()`.
fn fold_char(ch: char, out: &mut String) {
    if ('\u{0300}'..='\u{036f}').contains(&ch) {
        return;
    }
    let base = match ch {
        'À'..='Å' | 'à'..='å' | 'Ā' | 'ā' | 'Ă' | 'ă' | 'Ą' | 'ą' => Some('a'),
        'Ç' | 'ç' | 'Ć' | 'ć' | 'Ĉ' | 'ĉ' | 'Ċ' | 'ċ' | 'Č' | 'č' => Some('c'),
        'Ď' | 'ď' => Some('d'),
        'È'..='Ë' | 'è'..='ë' | 'Ē' | 'ē' | 'Ĕ' | 'ĕ' | 'Ė' | 'ė' | 'Ę' | 'ę' | 'Ě' | 'ě' => Some('e'),
        'Ĝ' | 'ĝ' | 'Ğ' | 'ğ' | 'Ġ' | 'ġ' | 'Ģ' | 'ģ' => Some('g'),
        'Ĥ' | 'ĥ' => Some('h'),
        'Ì'..='Ï' | 'ì'..='ï' | 'Ĩ' | 'ĩ' | 'Ī' | 'ī' | 'Ĭ' | 'ĭ' | 'Į' | 'į' | 'İ' => Some('i'),
        'Ĵ' | 'ĵ' => Some('j'),
        'Ķ' | 'ķ' => Some('k'),
        'Ĺ' | 'ĺ' | 'Ļ' | 'ļ' | 'Ľ' | 'ľ' => Some('l'),
        'Ñ' | 'ñ' | 'Ń' | 'ń' | 'Ņ' | 'ņ' | 'Ň' | 'ň' => Some('n'),
        'Ò'..='Ö' | 'ò'..='ö' | 'Ō' | 'ō' | 'Ŏ' | 'ŏ' | 'Ő' | 'ő' => Some('o'),
        'Ŕ' | 'ŕ' | 'Ŗ' | 'ŗ' | 'Ř' | 'ř' => Some('r'),
        'Ś' | 'ś' | 'Ŝ' | 'ŝ' | 'Ş' | 'ş' | 'Š' | 'š' => Some('s'),
        'Ţ' | 'ţ' | 'Ť' | 'ť' => Some('t'),
        'Ù'..='Ü' | 'ù'..='ü' | 'Ũ' | 'ũ' | 'Ū' | 'ū' | 'Ŭ' | 'ŭ' | 'Ů' | 'ů' | 'Ű' | 'ű' | 'Ų' | 'ų' => Some('u'),
        'Ŵ' | 'ŵ' => Some('w'),
        'Ý' | 'ý' | 'ÿ' | 'Ÿ' | 'Ŷ' | 'ŷ' => Some('y'),
        'Ź' | 'ź' | 'Ż' | 'ż' | 'Ž' | 'ž' => Some('z'),
        _ => None,
    };
    if let Some(mapped) = base {
        out.push(mapped);
    } else {
        for lower in ch.to_lowercase() {
            if !('\u{0300}'..='\u{036f}').contains(&lower) {
                out.push(lower);
            }
        }
    }
}

/// Lowercase without accents, so `"notificacoes"` finds `"Notificações"`.
pub fn fold_search_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        fold_char(ch, &mut out);
    }
    out
}

fn words(query: &str) -> Vec<String> {
    fold_search_text(query).split_whitespace().map(str::to_string).collect()
}

fn is_ascii_alnum(ch: char) -> bool {
    ch.is_ascii_lowercase() || ch.is_ascii_digit()
}

/// Where `word` starts in `text` (as a character index), preferring the start of a word over the middle of one.
fn word_start(text: &[char], word: &[char]) -> Option<usize> {
    if word.is_empty() || word.len() > text.len() {
        return None;
    }
    let find_from = |start: usize| -> Option<usize> { (start..=text.len() - word.len()).find(|&i| &text[i..i + word.len()] == word) };
    let first = find_from(0)?;
    let mut at = Some(first);
    while let Some(pos) = at {
        if pos > 0 && is_ascii_alnum(text[pos - 1]) {
            at = find_from(pos + 1);
            if at.is_none() {
                return Some(first);
            }
        } else {
            return Some(pos);
        }
    }
    Some(first)
}

/// The `[start, end)` character spans of `text` that the query's words match, merged and in order.
pub fn search_ranges(text: &str, query: &str) -> Vec<(usize, usize)> {
    let folded = fold_search_text(text);
    let folded_chars: Vec<char> = folded.chars().collect();
    let text_char_len = text.chars().count();
    if folded_chars.len() != text_char_len {
        return Vec::new();
    }
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for word in words(query) {
        let word_chars: Vec<char> = word.chars().collect();
        if let Some(at) = word_start(&folded_chars, &word_chars) {
            spans.push((at, at + word_chars.len()));
        }
    }
    spans.sort_by_key(|&(start, _)| start);
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in spans {
        if let Some(last) = merged.last_mut()
            && start <= last.1
        {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged
}

fn score_word(word: &str, title: &str, rest: &str) -> i32 {
    if title == word {
        return 100;
    }
    if title.starts_with(word) {
        return 80;
    }
    if let Some(byte_at) = title.find(word) {
        let preceded_by_alnum = title[..byte_at].chars().next_back().is_some_and(is_ascii_alnum);
        return if preceded_by_alnum { 40 } else { 60 };
    }
    if rest.contains(word) {
        return 15;
    }
    -1
}

/// Ranks `entries` against `query` using the exact scoring rules of `packages/shared/src/settings-search.ts`.
pub fn search_settings(entries: &[SettingsSearchEntry], query: &str, limit: usize) -> Vec<SettingsSearchHit> {
    let terms = words(query);
    if terms.is_empty() {
        return Vec::new();
    }
    let whole = terms.join(" ");
    let mut scored: Vec<(usize, i32)> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let title = fold_search_text(&entry.title);
        let page_title = entry.page.title();
        let mut rest_parts = Vec::with_capacity(4);
        if let Some(group) = &entry.group
            && !group.is_empty()
        {
            rest_parts.push(group.as_str());
        }
        if !page_title.is_empty() {
            rest_parts.push(page_title);
        }
        if let Some(desc) = &entry.description
            && !desc.is_empty()
        {
            rest_parts.push(desc.as_str());
        }
        if let Some(kw) = &entry.keywords
            && !kw.is_empty()
        {
            rest_parts.push(kw.as_str());
        }
        let rest = fold_search_text(&rest_parts.join(" "));
        let mut score = 0;
        let mut matched_all = true;
        for term in &terms {
            let one = score_word(term, &title, &rest);
            if one < 0 {
                matched_all = false;
                break;
            }
            score += one;
        }
        if !matched_all {
            continue;
        }
        if terms.len() > 1 && title.contains(&whole) {
            score += 50;
        }
        scored.push((index, score));
    }
    scored.sort_by(|&(idx_a, score_a), &(idx_b, score_b)| score_b.cmp(&score_a).then_with(|| idx_a.cmp(&idx_b)));
    let mut seen = std::collections::HashSet::new();
    let mut hits = Vec::new();
    for (index, _) in scored {
        let entry = &entries[index];
        let key = (entry.page, entry.title.as_str(), entry.group.as_deref().unwrap_or(""), entry.target_id.as_deref().unwrap_or(""));
        if !seen.insert(key) {
            continue;
        }
        hits.push(SettingsSearchHit { entry: entry.clone(), ranges: search_ranges(&entry.title, query) });
        if hits.len() >= limit {
            break;
        }
    }
    hits
}

/// The line under a result: the page it opens, then the card it sits in (`searchTrail` in `settings-search.ts`).
pub fn search_trail(entry: &SettingsSearchEntry) -> String {
    let page_title = entry.page.title();
    match entry.group.as_deref() {
        Some(group) if !group.is_empty() && group != page_title => format!("{page_title} › {group}"),
        _ => page_title.to_string(),
    }
}
