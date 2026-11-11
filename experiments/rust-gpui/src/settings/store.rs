//! In-memory Settings store with the React desktop defaults (`apps/desktop/app/src/lib/settings.ts` and
//! `@milagre/shared/context-settings`). No persistence and no daemon calls: a later package wires real data.

use std::collections::HashSet;

use gpui::Global;

use crate::data::Provider;
use crate::logic::lists::order::ChatOrder;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditorChoice {
    Cursor,
    Vscode,
    Zed,
    System,
}

impl EditorChoice {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cursor => "cursor",
            Self::Vscode => "vscode",
            Self::Zed => "zed",
            Self::System => "system",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "cursor" => Self::Cursor,
            "vscode" => Self::Vscode,
            "zed" => Self::Zed,
            _ => Self::System,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatListMode {
    List,
    Grouped,
}

impl ChatListMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Grouped => "grouped",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "grouped" => Self::Grouped,
            _ => Self::List,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageDisplayMode {
    Used,
    Remaining,
}

impl UsageDisplayMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Used => "used",
            Self::Remaining => "remaining",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "remaining" => Self::Remaining,
            _ => Self::Used,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowUpMode {
    Now,
    Queue,
}

impl FollowUpMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Now => "now",
            Self::Queue => "queue",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "queue" => Self::Queue,
            _ => Self::Now,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCallDisplay {
    Compact,
    Full,
}

impl ToolCallDisplay {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Compact => "compact",
            Self::Full => "full",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "full" => Self::Full,
            _ => Self::Compact,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationSchedule {
    /// Selected day indices (`0 = Sun` .. `6 = Sat`), never empty.
    pub days: Vec<u8>,
    pub start: String,
    pub end: String,
    pub time_zone: String,
}

impl NotificationSchedule {
    pub fn work_hours() -> Self {
        Self { days: vec![1, 2, 3, 4, 5], start: "09:00".to_string(), end: "17:00".to_string(), time_zone: "UTC".to_string() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionMode {
    Ask,
    Auto,
    Full,
}

impl PermissionMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Auto => "auto",
            Self::Full => "full",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "auto" => Self::Auto,
            "full" => Self::Full,
            _ => Self::Ask,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactButtonDisplay {
    Threshold,
    Always,
}

impl CompactButtonDisplay {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Threshold => "threshold",
            Self::Always => "always",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "always" => Self::Always,
            _ => Self::Threshold,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeReplyStyle {
    Default,
    Concise,
}

impl ClaudeReplyStyle {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Concise => "concise",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "concise" => Self::Concise,
            _ => Self::Default,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenLinksIn {
    Browser,
    Panel,
}

impl OpenLinksIn {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Panel => "panel",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "panel" => Self::Panel,
            _ => Self::Browser,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseChannel {
    Stable,
    Beta,
}

impl ReleaseChannel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "beta" => Self::Beta,
            _ => Self::Stable,
        }
    }
}

/// Static model option from `@milagre/shared/model-options` (`MODEL_CATALOG`).
#[derive(Clone, Copy, Debug)]
pub struct ModelCatalogOption {
    pub id: &'static str,
    pub name: &'static str,
    pub provider: Provider,
    pub description: &'static str,
}

pub const MODEL_CATALOG: &[ModelCatalogOption] = &[
    ModelCatalogOption {
        id: "gpt-6.1-sol",
        name: "GPT-6.1-Sol",
        provider: Provider::Codex,
        description: "Latest generation workhorse model",
    },
    ModelCatalogOption {
        id: "gpt-6-astra",
        name: "GPT-6-Astra",
        provider: Provider::Codex,
        description: "Frontier intelligence for the most demanding work",
    },
    ModelCatalogOption {
        id: "gpt-6-sol",
        name: "GPT-6-Sol",
        provider: Provider::Codex,
        description: "Previous generation workhorse model",
    },
    ModelCatalogOption {
        id: "gpt-6-luna",
        name: "GPT-6-Luna",
        provider: Provider::Codex,
        description: "Fast and affordable model for easier tasks",
    },
    ModelCatalogOption {
        id: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        provider: Provider::Codex,
        description: "Older generation workhorse model",
    },
    ModelCatalogOption {
        id: "gpt-5.6-terra",
        name: "GPT-5.6-Terra",
        provider: Provider::Codex,
        description: "Older balanced model for straightforward work",
    },
    ModelCatalogOption {
        id: "gpt-5.6-luna",
        name: "GPT-5.6-Luna",
        provider: Provider::Codex,
        description: "Older fast and efficient model",
    },
    ModelCatalogOption { id: "gpt-5.5", name: "GPT-5.5", provider: Provider::Codex, description: "Legacy coding model" },
    ModelCatalogOption {
        id: "claude-opus-5-5",
        name: "Opus 5.5",
        provider: Provider::Claude,
        description: "For complex work and everyday tasks",
    },
    ModelCatalogOption {
        id: "claude-fable-5-1",
        name: "Fable 5.1",
        provider: Provider::Claude,
        description: "For your toughest challenges",
    },
    ModelCatalogOption {
        id: "claude-sonnet-5-5",
        name: "Sonnet 5.5",
        provider: Provider::Claude,
        description: "Most efficient for simpler tasks",
    },
    ModelCatalogOption { id: "claude-haiku-4-5", name: "Haiku 4.5", provider: Provider::Claude, description: "Fastest for quick answers" },
    ModelCatalogOption { id: "claude-sonnet-5", name: "Sonnet 5", provider: Provider::Claude, description: "Efficient for routine tasks" },
    ModelCatalogOption { id: "claude-opus-5", name: "Opus 5", provider: Provider::Claude, description: "Best for everyday, complex tasks" },
    ModelCatalogOption {
        id: "claude-fable-5",
        name: "Fable 5",
        provider: Provider::Claude,
        description: "Most capable for your hardest and longest-running tasks",
    },
    ModelCatalogOption {
        id: "claude-opus-4-8",
        name: "Opus 4.8",
        provider: Provider::Claude,
        description: "Best for everyday, complex tasks",
    },
    ModelCatalogOption {
        id: "claude-opus-4-7",
        name: "Opus 4.7",
        provider: Provider::Claude,
        description: "Best for everyday, complex tasks",
    },
    ModelCatalogOption {
        id: "claude-opus-4-6",
        name: "Opus 4.6",
        provider: Provider::Claude,
        description: "Best for everyday, complex tasks",
    },
    ModelCatalogOption {
        id: "claude-sonnet-4-6",
        name: "Sonnet 4.6",
        provider: Provider::Claude,
        description: "Efficient for routine tasks",
    },
    ModelCatalogOption { id: "gemini-4-argon", name: "Gemini 4 Argon", provider: Provider::Antigravity, description: "For complex work" },
    ModelCatalogOption { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: Provider::Antigravity, description: "Fast" },
    ModelCatalogOption {
        id: "kiro:auto",
        name: "Auto",
        provider: Provider::Kiro,
        description: "Models chosen by task for optimal usage and consistent quality",
    },
    ModelCatalogOption {
        id: "kiro:claude-opus-5.5",
        name: "Claude Opus 5.5",
        provider: Provider::Kiro,
        description: "Claude Opus 5.5 model with 1M context window",
    },
    ModelCatalogOption {
        id: "kiro:claude-sonnet-5.5",
        name: "Claude Sonnet 5.5",
        provider: Provider::Kiro,
        description: "Claude Sonnet 5.5 model with 1M context window",
    },
    ModelCatalogOption {
        id: "kiro:claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        provider: Provider::Kiro,
        description: "The latest Claude Haiku model",
    },
    ModelCatalogOption {
        id: "kiro:gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        provider: Provider::Kiro,
        description: "OpenAI GPT 5.6 Sol with 1M context window",
    },
    ModelCatalogOption {
        id: "kiro:gpt-5.6-luna",
        name: "GPT 5.6 Luna",
        provider: Provider::Kiro,
        description: "OpenAI GPT 5.6 Luna with 1M context window",
    },
];

/// All in-memory values for WP-39's simple Settings sections, initialized with the React desktop defaults.
#[derive(Clone, Debug)]
pub struct SettingsStore {
    // General
    pub default_editor: EditorChoice,
    pub chat_order: ChatOrder,
    pub chat_list: ChatListMode,
    pub done_retention_hours: u32,
    pub usage_display_mode: UsageDisplayMode,
    pub show_usage_bars: bool,
    pub keep_awake: bool,

    // Chat
    pub follow_ups: FollowUpMode,
    pub expand_reasoning: bool,
    pub tool_call_display: ToolCallDisplay,

    // Notifications
    pub notify_on_complete: bool,
    pub show_dock_badge: bool,
    pub notify_on_attention: bool,
    pub show_attention_inbox: bool,
    pub notification_schedule: Option<NotificationSchedule>,
    pub notification_chime: String,
    pub last_played_chime: Option<String>,
    pub show_unread_runs_dot: bool,

    // Models
    pub default_model: String,
    pub default_permission_mode: PermissionMode,
    pub show_context_size: bool,
    pub auto_compact: bool,
    pub button_threshold: u8,
    pub auto_threshold: u8,
    pub compact_button_display: CompactButtonDisplay,
    pub tldr_enabled: bool,
    pub claude_reply_style: ClaudeReplyStyle,

    // Browser
    pub open_links_in: OpenLinksIn,
    pub signed_out_sessions: HashSet<String>,

    // Church (Experimental)
    pub floating_inbox: bool,
    pub floating_inbox_ticker: bool,
    pub ultracode_fatality: bool,
    pub new_chat_stats: bool,
    pub delegate_to_other_computers: bool,
    pub device_notes: bool,

    // About
    pub release_channel: ReleaseChannel,
    pub auto_update: bool,
    pub update_checks: usize,
}

impl Global for SettingsStore {}

impl Default for SettingsStore {
    fn default() -> Self {
        Self {
            // General (`DEFAULTS` in `apps/desktop/app/src/lib/settings.ts` and `DONE_DEFAULTS`)
            default_editor: EditorChoice::Cursor,
            chat_order: ChatOrder::Created,
            chat_list: ChatListMode::List,
            done_retention_hours: 24,
            usage_display_mode: UsageDisplayMode::Used,
            show_usage_bars: true,
            keep_awake: true,

            // Chat (`CONTEXT_DEFAULTS.followUps` + `DEFAULTS`)
            follow_ups: FollowUpMode::Now,
            expand_reasoning: false,
            tool_call_display: ToolCallDisplay::Compact,

            // Notifications (`DEFAULTS`)
            notify_on_complete: true,
            show_dock_badge: true,
            notify_on_attention: true,
            show_attention_inbox: true,
            notification_schedule: None,
            notification_chime: "system".to_string(),
            last_played_chime: None,
            show_unread_runs_dot: true,

            // Models (`DEFAULTS` + `CONTEXT_DEFAULTS`)
            default_model: "gpt-6.1-sol".to_string(),
            default_permission_mode: PermissionMode::Ask,
            show_context_size: true,
            auto_compact: false,
            button_threshold: 70,
            auto_threshold: 85,
            compact_button_display: CompactButtonDisplay::Threshold,
            tldr_enabled: false,
            claude_reply_style: ClaudeReplyStyle::Default,

            // Browser (`DEFAULTS`)
            open_links_in: OpenLinksIn::Browser,
            signed_out_sessions: HashSet::new(),

            // Church (`DEFAULTS` + host settings defaults)
            floating_inbox: false,
            floating_inbox_ticker: true,
            ultracode_fatality: true,
            new_chat_stats: false,
            delegate_to_other_computers: false,
            device_notes: false,

            // About
            release_channel: ReleaseChannel::Stable,
            auto_update: false,
            update_checks: 0,
        }
    }
}

impl SettingsStore {
    /// Clamps and updates the Compact button threshold (`5..=90`) and ensures `auto_threshold >= button_threshold + 5`.
    pub fn set_button_threshold(&mut self, value: u8) {
        let clamped = value.clamp(5, 90);
        self.button_threshold = clamped;
        if self.auto_threshold < clamped + 5 {
            self.auto_threshold = (clamped + 5).clamp(10, 95);
        }
    }

    /// Clamps and updates the Auto compact threshold (`button_threshold + 5 ..= 95`).
    pub fn set_auto_threshold(&mut self, value: u8) {
        let min = (self.button_threshold + 5).min(95);
        self.auto_threshold = value.clamp(min, 95);
    }

    /// Resets context thresholds back to `(70, 85)` (`CONTEXT_DEFAULTS`).
    pub fn reset_context_thresholds(&mut self) {
        self.button_threshold = 70;
        self.auto_threshold = 85;
    }
}
