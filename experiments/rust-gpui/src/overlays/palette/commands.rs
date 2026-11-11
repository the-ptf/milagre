//! The palette's rules: [`Command`], `filterCommands` (`lib/commands.ts`), the Recent group
//! (`lib/recent-commands.ts`), message rows (`lib/message-commands.ts`) and the quick settings
//! (`lib/settings-commands.ts`).
//!
//! A command carries what to do as data ([`CommandAction`]), not a closure: the window runs it
//! (`Workspace::run_command`), and a test compares it.

use std::collections::HashMap;

use gpui::Global;

use crate::logic::lists::order::ChatOrder;
use crate::settings::SettingsStore;
use crate::settings::appearance::model::ThemePreference;
use crate::settings::store::{ClaudeReplyStyle, UsageDisplayMode};

/// How many of the last commands ⌘K offers before anything is typed (`RECENT_LIMIT`).
pub const RECENT_LIMIT: usize = 5;
/// Rows of message matches: three per Chat, thirty in all (`PER_CHAT`, `TOTAL`).
pub const MESSAGES_PER_CHAT: usize = 3;
pub const MESSAGES_TOTAL: usize = 30;
/// The id of the one row offered when nothing matches (`start-chat-with-search`).
pub const START_CHAT_ID: &str = "start-chat-with-search";

/// The icon a row shows (`icons` in `CommandPalette.tsx`); `icon_name` in `mod.rs` maps it to a glyph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandIcon {
    Chat,
    Add,
    Folder,
    Settings,
    Git,
    Editor,
    Copy,
    Unread,
    Search,
    Message,
    Reload,
    Routines,
    Usage,
    NewChat,
    Storage,
    Triage,
    Terminal,
    Link,
    PullRequest,
    FolderAdd,
    Canvas,
}

/// Which Settings checkbox a quick setting flips.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flag {
    ShowUsage,
    Tldr,
    NotifyOnCompletion,
    NotifyWhenWaiting,
    DockBadge,
    AttentionButton,
    FloatingInbox,
    KeepAwake,
}

/// An explicit value, so a quick setting is searchable and safe to run twice (`settingsCommands`).
#[derive(Clone, Debug, PartialEq)]
pub enum QuickSetting {
    Mode(ThemePreference),
    ColorTheme(String),
    UsageDisplay(UsageDisplayMode),
    ChatOrder(ChatOrder),
    SidebarUsage(&'static str),
    ProviderIcons(&'static str),
    ClaudeReplies(ClaudeReplyStyle),
    Flag(Flag, bool),
}

impl QuickSetting {
    /// Whether the store already holds this value (the row's "Current").
    pub fn is_current(&self, store: &SettingsStore) -> bool {
        match self {
            Self::Mode(mode) => store.appearance.theme == *mode,
            Self::ColorTheme(id) => store.appearance.color_theme == *id,
            Self::UsageDisplay(mode) => store.usage_display_mode == *mode,
            Self::ChatOrder(order) => store.chat_order == *order,
            Self::SidebarUsage(value) => store.appearance.options.sidebar_usage == *value,
            Self::ProviderIcons(value) => store.appearance.options.provider_icons == *value,
            Self::ClaudeReplies(style) => store.claude_reply_style == *style,
            Self::Flag(flag, value) => flag.read(store) == *value,
        }
    }

    pub fn apply(&self, store: &mut SettingsStore) {
        match self {
            Self::Mode(mode) => store.appearance.theme = *mode,
            Self::ColorTheme(id) => store.appearance.color_theme = id.clone(),
            Self::UsageDisplay(mode) => store.usage_display_mode = *mode,
            Self::ChatOrder(order) => store.chat_order = *order,
            Self::SidebarUsage(value) => store.appearance.options.sidebar_usage = (*value).to_string(),
            Self::ProviderIcons(value) => store.appearance.options.provider_icons = (*value).to_string(),
            Self::ClaudeReplies(style) => store.claude_reply_style = *style,
            Self::Flag(flag, value) => flag.write(store, *value),
        }
    }
}

impl Flag {
    fn read(self, store: &SettingsStore) -> bool {
        match self {
            Self::ShowUsage => store.show_usage_bars,
            Self::Tldr => store.tldr_enabled,
            Self::NotifyOnCompletion => store.notify_on_complete,
            Self::NotifyWhenWaiting => store.notify_on_attention,
            Self::DockBadge => store.show_dock_badge,
            Self::AttentionButton => store.show_attention_inbox,
            Self::FloatingInbox => store.floating_inbox,
            Self::KeepAwake => store.keep_awake,
        }
    }

    fn write(self, store: &mut SettingsStore, value: bool) {
        match self {
            Self::ShowUsage => store.show_usage_bars = value,
            Self::Tldr => store.tldr_enabled = value,
            Self::NotifyOnCompletion => store.notify_on_complete = value,
            Self::NotifyWhenWaiting => store.notify_on_attention = value,
            Self::DockBadge => store.show_dock_badge = value,
            Self::AttentionButton => store.show_attention_inbox = value,
            Self::FloatingInbox => store.floating_inbox = value,
            Self::KeepAwake => store.keep_awake = value,
        }
    }
}

/// What running a command does. The window carries these out.
#[derive(Clone, Debug, PartialEq)]
pub enum CommandAction {
    NewChat,
    AddProject,
    OpenRoutines,
    /// Settings on a page, and on a row of it when one is named (`settingsPageCommands`).
    OpenSettings(Option<crate::settings::SettingsSearchEntry>),
    ToggleTheme,
    BackToChat,
    OpenGitActions,
    OpenChat(String),
    OpenProject(String),
    /// A message match: open its Chat (the search term is for the find bar).
    OpenMessage {
        chat: String,
        term: String,
    },
    /// "Start a new Chat with your search": a new Chat with the query as its draft.
    StartChat(String),
    SetSetting(QuickSetting),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Command {
    pub id: String,
    pub label: String,
    pub group: String,
    pub detail: Option<String>,
    /// A sentence under the label on the highlighted row only, never in the right column.
    pub hint: Option<String>,
    pub keywords: String,
    /// The keybinding command whose key the row shows and runs it with (`chat.new`).
    pub keybinding: Option<&'static str>,
    /// The matched text inside `label`, as byte offsets, bolded in the palette.
    pub highlight: Option<(usize, usize)>,
    pub icon: CommandIcon,
    pub action: CommandAction,
    /// Listed only once something is typed: every Settings row would bury the actions in an empty palette.
    pub search_only: bool,
}

impl Command {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        group: impl Into<String>,
        icon: CommandIcon,
        action: CommandAction,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            group: group.into(),
            detail: None,
            hint: None,
            keywords: String::new(),
            keybinding: None,
            highlight: None,
            icon,
            action,
            search_only: false,
        }
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        self.detail = (!detail.is_empty()).then_some(detail);
        self
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn keywords(mut self, keywords: impl Into<String>) -> Self {
        self.keywords = keywords.into();
        self
    }

    pub fn keybinding(mut self, command: &'static str) -> Self {
        self.keybinding = Some(command);
        self
    }

    pub fn search_only(mut self) -> Self {
        self.search_only = true;
        self
    }
}

/// Match every word across the title, location and aliases, keeping the curated group order. An empty query lists
/// everything but the search-only rows; those don't match on their group's name, so "settings" finds the Settings
/// actions and pages, not every row in them (`filterCommands`).
pub fn filter_commands(commands: &[Command], query: &str) -> Vec<Command> {
    let lowered = query.to_lowercase();
    let words: Vec<&str> = lowered.split_whitespace().collect();
    if words.is_empty() {
        return commands.iter().filter(|command| !command.search_only).cloned().collect();
    }
    commands
        .iter()
        .filter(|command| {
            let group = if command.search_only { "" } else { command.group.as_str() };
            let text = format!(
                "{} {} {} {} {}",
                command.label,
                command.detail.as_deref().unwrap_or(""),
                command.hint.as_deref().unwrap_or(""),
                command.keywords,
                group
            )
            .to_lowercase();
            words.iter().all(|word| text.contains(word))
        })
        .cloned()
        .collect()
}

/// The ids of the last commands run from ⌘K, newest first, as a window global (the desktop keeps them in its
/// preference storage).
#[derive(Clone, Debug, Default)]
pub struct RecentCommands(pub Vec<String>);

impl Global for RecentCommands {}

impl RecentCommands {
    /// Puts `id` first, once, keeping the newest [`RECENT_LIMIT`] (`rememberCommand`).
    pub fn remember(&mut self, id: &str) {
        self.0.retain(|saved| saved != id);
        self.0.insert(0, id.to_string());
        self.0.truncate(RECENT_LIMIT);
    }
}

/// The remembered commands that still exist, newest first, as copies in a "Recent" group: a Chat since deleted or an
/// action this screen doesn't offer is skipped. Each copy keeps the original's id after `recent:` (`recentCommands`).
pub fn recent_commands(commands: &[Command], ids: &[String]) -> Vec<Command> {
    ids.iter()
        .filter_map(|id| commands.iter().find(|command| command.id == *id))
        .map(|command| Command {
            id: format!("recent:{}", command.id),
            group: "Recent".to_string(),
            highlight: None,
            search_only: false,
            ..command.clone()
        })
        .collect()
}

/// The id a palette row is remembered under: a Recent row's original (`rememberedId`).
pub fn remembered_id(command: &Command) -> &str {
    command.id.strip_prefix("recent:").unwrap_or(&command.id)
}

/// One message the search found, in the host's words (`ChatSearchMatch`).
#[derive(Clone, Debug, PartialEq)]
pub struct MessageMatch {
    pub message_id: u64,
    /// The Chat's key.
    pub chat: String,
    pub snippet: String,
    /// The matched text in `snippet`, as byte offsets.
    pub highlight: (usize, usize),
    pub term: String,
}

/// Palette rows for the matches, in listed Chats only (`titles`), at most three per Chat and thirty in all
/// (`messageCommandsFrom`).
pub fn message_commands(matches: &[MessageMatch], titles: &HashMap<String, String>) -> Vec<Command> {
    let mut per_chat: HashMap<&str, usize> = HashMap::new();
    let mut out = Vec::new();
    for found in matches {
        let Some(title) = titles.get(&found.chat) else { continue };
        let count = per_chat.entry(found.chat.as_str()).or_default();
        if *count >= MESSAGES_PER_CHAT {
            continue;
        }
        *count += 1;
        let mut command = Command::new(
            format!("message:{}", found.message_id),
            found.snippet.clone(),
            "Messages",
            CommandIcon::Message,
            CommandAction::OpenMessage { chat: found.chat.clone(), term: found.term.clone() },
        )
        .detail(title.clone());
        command.highlight = Some(found.highlight);
        out.push(command);
        if out.len() >= MESSAGES_TOTAL {
            break;
        }
    }
    out
}

/// A search over message bodies: `(chat key, message id, body)`. Messages matching every word of the query, best
/// first; each word matches by prefix of a word or inside a longer word (the host's `chat:search` also forgives
/// typos; that fuzzy index stays on the host).
pub fn search_messages(messages: &[(String, u64, String)], query: &str, limit: usize) -> Vec<MessageMatch> {
    let lowered = query.to_lowercase();
    let words: Vec<&str> = lowered.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(i32, usize, MessageMatch)> = Vec::new();
    for (position, (chat, id, body)) in messages.iter().enumerate() {
        let text = body.to_lowercase();
        // Lowercasing can change byte lengths for a few scripts: skip those bodies rather than slice wrongly.
        if text.len() != body.len() {
            continue;
        }
        let mut score = 0;
        let mut first: Option<(usize, usize)> = None;
        let mut all = true;
        for word in &words {
            match text.find(word) {
                Some(at) => {
                    let starts_word = at == 0 || !text[..at].chars().next_back().is_some_and(char::is_alphanumeric);
                    score += if starts_word { 3 } else { 2 };
                    if first.is_none_or(|(start, _)| at < start) {
                        first = Some((at, at + word.len()));
                    }
                }
                None => {
                    all = false;
                    break;
                }
            }
        }
        if let (true, Some((start, end))) = (all, first) {
            let (snippet, highlight) = snippet_around(body, start, end, 90);
            scored.push((
                score,
                position,
                MessageMatch { message_id: *id, chat: chat.clone(), snippet, highlight, term: query.trim().to_string() },
            ));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|(_, _, found)| found).collect()
}

/// Up to ~`width` characters of `text` around `[start, end)`, on word boundaries, and the match's place in the result
/// (`snippetAround` in `packages/shared/src/message-search.mjs`).
pub fn snippet_around(text: &str, start: usize, end: usize, width: usize) -> (String, (usize, usize)) {
    let boundary = |mut at: usize, up: bool| {
        while !text.is_char_boundary(at) {
            if up { at += 1 } else { at -= 1 }
        }
        at
    };
    let lead = start.min(width.saturating_sub(end - start) / 3);
    let mut from = boundary(start - lead, true);
    let mut to = boundary((from + width).min(text.len()), true);
    if from > 0
        && let Some(space) = text[..from].rfind(' ')
        && start - space < width / 2
    {
        from = space + 1;
    }
    if to < text.len()
        && let Some(offset) = text[to..].find(' ')
        && offset < 12
    {
        to += offset;
    }
    // Runs of whitespace become one space; the edges keep theirs so the match stays apart from its neighbours.
    let collapse = |value: &str| {
        let mut out = String::with_capacity(value.len());
        for c in value.chars() {
            if c.is_whitespace() {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            } else {
                out.push(c);
            }
        }
        out
    };
    let before = format!("{}{}", if from > 0 { "\u{2026}" } else { "" }, collapse(&text[from..start]).trim_start());
    let matched = collapse(&text[start..end]);
    let after = format!("{}{}", collapse(&text[end..to]).trim_end(), if to < text.len() { "\u{2026}" } else { "" });
    let highlight = (before.len(), before.len() + matched.len());
    (format!("{before}{matched}{after}"), highlight)
}

/// The quick settings (`settingsCommands`): explicit values, found by typing, "Current" on the one in effect.
pub fn quick_settings(store: &SettingsStore) -> Vec<Command> {
    let mut out = Vec::new();
    let mut choice = |id: String, label: String, keywords: &str, setting: QuickSetting| {
        let current = setting.is_current(store);
        let command =
            Command::new(id, label, "Quick settings", CommandIcon::Settings, CommandAction::SetSetting(setting)).keywords(keywords);
        out.push(if current { command.detail("Current") } else { command });
    };
    let id_of = |setting: &QuickSetting| format!("setting:{setting:?}").replace(' ', "");
    for (mode, label, keywords) in [
        (ThemePreference::Dark, "Mode: Dark", "appearance color mode"),
        (ThemePreference::Light, "Mode: Light", "appearance color mode"),
        (ThemePreference::System, "Mode: System", "appearance color mode automatic"),
    ] {
        let setting = QuickSetting::Mode(mode);
        choice(id_of(&setting), label.into(), keywords, setting);
    }
    for theme in crate::settings::appearance::themes::themes() {
        let group = crate::settings::appearance::themes::ThemeGroup::Catppuccin;
        let name = if theme.group == group { format!("Catppuccin {}", theme.name) } else { theme.name.to_string() };
        let setting = QuickSetting::ColorTheme(theme.id.to_string());
        choice(id_of(&setting), format!("Theme: {name}"), "appearance color theme", setting);
    }
    let rest = [
        (QuickSetting::UsageDisplay(UsageDisplayMode::Used), "Usage: Used", "plan limits"),
        (QuickSetting::UsageDisplay(UsageDisplayMode::Remaining), "Usage: Remaining", "plan limits left"),
        (QuickSetting::Flag(Flag::ShowUsage, true), "Sidebar usage: Show", "on enable plan limits"),
        (QuickSetting::Flag(Flag::ShowUsage, false), "Sidebar usage: Hide", "off disable plan limits"),
        (QuickSetting::SidebarUsage("expanded"), "Sidebar usage: Expanded", "appearance plan limits rows"),
        (QuickSetting::SidebarUsage("compact"), "Sidebar usage: Compact", "appearance plan limits icons one line"),
        (QuickSetting::ProviderIcons("original"), "Provider icons: Original", "appearance logos brand colors"),
        (QuickSetting::ProviderIcons("simplified"), "Provider icons: Simplified", "appearance logos monochrome black white"),
        (QuickSetting::ChatOrder(ChatOrder::Created), "Chat order: Newest Chat first", "sidebar sort created date"),
        (QuickSetting::ChatOrder(ChatOrder::Recent), "Chat order: Latest message first", "sidebar sort recent activity"),
        (QuickSetting::ClaudeReplies(ClaudeReplyStyle::Concise), "Claude replies: Concise", "short responses"),
        (QuickSetting::ClaudeReplies(ClaudeReplyStyle::Default), "Claude replies: Normal", "responses"),
    ];
    for (setting, label, keywords) in rest {
        choice(id_of(&setting), label.into(), keywords, setting);
    }
    for (flag, label, keywords) in [
        (Flag::Tldr, "TLDR writing", "replies responses"),
        (Flag::NotifyOnCompletion, "Notify when finished", "notifications completion"),
        (Flag::NotifyWhenWaiting, "Notify when waiting", "notifications approval questions"),
        (Flag::DockBadge, "Dock badge", "unread count"),
        (Flag::AttentionButton, "Attention button", "other projects waiting approval questions"),
        (Flag::FloatingInbox, "Floating inbox", "experimental notification bar"),
        (Flag::KeepAwake, "Keep the computer awake", "sleep reachable lock screen saver"),
    ] {
        for (value, word, extra) in [(true, "On", "enable"), (false, "Off", "disable")] {
            let setting = QuickSetting::Flag(flag, value);
            choice(id_of(&setting), format!("{label}: {word}"), &format!("{keywords} {extra}"), setting);
        }
    }
    out
}

/// What the host's message search answered for one query.
#[derive(Clone, Debug, Default)]
pub struct Found {
    pub query: String,
    pub commands: Vec<Command>,
}

/// The rows ⌘K lists for `query`, and whether it is still waiting on the host's message search.
pub struct Results {
    pub rows: Vec<Command>,
    pub searching: bool,
}

/// A query this short does not ask the host for messages.
pub const MIN_SEARCH: usize = 2;

/// The palette's list (`CommandPalette`): Recent then everything when nothing is typed; the matching commands when
/// something is; the message matches only when no command, Chat or Project matches; and, when nothing matches at
/// all, one row that starts a new Chat with the search as its draft. While the host is still looking, nothing is
/// offered, so that row does not flash in and out.
pub fn results(commands: &[Command], recent_ids: &[String], query: &str, found: &Found) -> Results {
    let typed = !query.trim().is_empty();
    let matches = if typed {
        filter_commands(commands, query)
    } else {
        let mut all = recent_commands(commands, recent_ids);
        all.extend(filter_commands(commands, query));
        all
    };
    // Settings rows found by their words don't stand in for a Chat's: messages are still searched beside them.
    let by_command = matches.iter().any(|command| !command.search_only);
    let asks_host = typed && !by_command && query.trim().chars().count() >= MIN_SEARCH;
    let messages: &[Command] = if asks_host && found.query == query { &found.commands } else { &[] };
    let mut rows = matches;
    rows.extend_from_slice(messages);
    let searching = asks_host && found.query != query;
    if rows.is_empty() && !searching && typed {
        rows.push(Command::new(
            START_CHAT_ID,
            "Start a new Chat with your search",
            "New Chat",
            CommandIcon::NewChat,
            CommandAction::StartChat(query.trim().to_string()),
        ));
    }
    Results { rows, searching }
}

/// Where the selection goes on an arrow key, wrapping at both ends.
pub fn step_selection(len: usize, current: usize, down: bool) -> usize {
    if len == 0 {
        0
    } else if down {
        (current + 1) % len
    } else {
        (current + len - 1) % len
    }
}
