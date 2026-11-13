//! What ⌘K lists (`App.tsx` `commands`): the actions, the current Chat's, every Chat, the other Projects and, once
//! something is typed, the Settings pages and rows. Pure: the window gathers a [`PaletteInput`] and the lists come
//! out in the curated group order.
//!
//! Left out until their screens exist in this port (each is one more `push` here): New Terminal, Projects and
//! Links (the canvas), Token usage, Clean up worktrees, Triage an issue, Project settings, Show active Chats as a
//! grid, and the Current Chat rows that need the host (Open in editor, Reveal folder, Find in Chat, Mark as unread,
//! Reload Chat, Report a Milagre bug, Copy Worktree path).

use super::commands::{Command, CommandAction, CommandIcon};
use crate::logic::copy::model_copy::UI_COPY;
use crate::logic::marks::chat_mark::ChatMark;
use crate::settings::{SETTINGS_INDEX, SettingsSearchEntry, SettingsSectionId, search_trail};

/// A Chat the palette can open.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatEntry {
    pub key: String,
    pub title: String,
    pub mark: ChatMark,
    /// "project · #PR · +n · computer", searched like the Chat's path and PR titles.
    pub detail: String,
}

/// A Project the palette can switch to.
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectEntry {
    pub path: String,
    pub name: String,
}

/// What the window knows when ⌘K opens.
#[derive(Clone, Debug, Default)]
pub struct PaletteInput {
    pub chats: Vec<ChatEntry>,
    /// The Projects other than the open one.
    pub projects: Vec<ProjectEntry>,
    /// A Chat is open (its group lists).
    pub current_chat: bool,
    /// The open Chat's Project is a Git repository.
    pub git: bool,
    /// Routines or Settings is on screen: "Back to Chat" is offered.
    pub away_from_chat: bool,
}

/// "Needs you" and the like: the status words in a Chat row's right column.
pub fn mark_detail(mark: ChatMark) -> &'static str {
    match mark {
        ChatMark::Question | ChatMark::Waiting => "Needs you",
        ChatMark::Running => "Working",
        ChatMark::Background => "In the background",
        ChatMark::Unread => "Unread",
        _ => "",
    }
}

/// Every command in the palette, in group order: Actions, Current Chat, Chats, Projects, Settings.
pub fn commands(input: &PaletteInput) -> Vec<Command> {
    let actions = "Actions";
    let mut out = vec![
        Command::new("new-chat", UI_COPY.new_chat, actions, CommandIcon::Add, CommandAction::NewChat)
            .keybinding("chat.new")
            .keywords("create agent session"),
        Command::new("open-project", UI_COPY.add_project, actions, CommandIcon::FolderAdd, CommandAction::AddProject)
            .keybinding("project.add")
            .keywords("add repository workspace folder"),
        Command::new("routines", "Routines", actions, CommandIcon::Routines, CommandAction::OpenRoutines)
            .keywords("heartbeats triggers schedule linear webhook automations"),
        Command::new("settings", "Settings", actions, CommandIcon::Settings, CommandAction::OpenSettings(None))
            .keybinding("settings.open")
            .keywords("preferences model permissions"),
        Command::new(
            "appearance",
            "Appearance settings",
            actions,
            CommandIcon::Settings,
            CommandAction::OpenSettings(Some(SettingsSearchEntry::row(SettingsSectionId::Appearance, "Appearance", None, None, None))),
        )
        .keywords("theme preferences"),
        Command::new("toggle-theme", "Toggle theme", actions, CommandIcon::Settings, CommandAction::ToggleTheme)
            .keybinding("theme.toggle")
            .keywords("appearance switch color mode"),
    ];
    if input.away_from_chat {
        out.push(Command::new("back-to-chat", UI_COPY.back_to_chat, actions, CommandIcon::Chat, CommandAction::BackToChat));
    }
    if input.current_chat && input.git {
        out.insert(
            0,
            Command::new(
                "git",
                "Commit and open PR\u{2026}",
                UI_COPY.current_chat,
                CommandIcon::PullRequest,
                CommandAction::OpenGitActions,
            )
            .keywords("git changes pull request push"),
        );
    }
    out.extend(input.chats.iter().map(|chat| {
        let detail = mark_detail(chat.mark);
        Command::new(
            format!("chat:{}", chat.key),
            chat.title.clone(),
            "Chats",
            CommandIcon::Chat,
            CommandAction::OpenChat(chat.key.clone()),
        )
        .detail(detail)
        .keywords(chat.detail.clone())
    }));
    out.extend(input.projects.iter().map(|project| {
        Command::new(
            format!("project:{}", project.path),
            project.name.clone(),
            "Projects",
            CommandIcon::Folder,
            CommandAction::OpenProject(project.path.clone()),
        )
        .detail(project.path.clone())
    }));
    out.extend(settings_page_commands());
    out
}

/// Every Settings page and every row on one, found by typing: a page opens Settings there, a row opens its page
/// scrolled to the row (`settingsPageCommands`). Last, so a Chat or an action with the same words comes first.
pub fn settings_page_commands() -> Vec<Command> {
    let mut out: Vec<Command> = crate::settings::ALL_SECTIONS
        .iter()
        .copied()
        .map(|section| {
            let entry = SettingsSearchEntry::row(section, section.title(), None, None, None);
            Command::new(
                format!("settings-page:{}", section.as_str()),
                section.title(),
                "Settings",
                CommandIcon::Settings,
                CommandAction::OpenSettings(Some(entry)),
            )
            .detail("Settings")
            .keywords(format!("settings preferences {}", section.keywords()))
            .search_only()
        })
        .collect();
    out.extend(SETTINGS_INDEX.iter().map(|row| {
        let entry = row.to_entry();
        let page = entry.page.title();
        let keywords = [page, entry.description.as_deref().unwrap_or(""), entry.keywords.as_deref().unwrap_or("")]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        Command::new(
            format!("settings-row:{}:{}:{}", entry.page.as_str(), entry.group.as_deref().unwrap_or(""), entry.title),
            entry.title.clone(),
            "Settings",
            CommandIcon::Settings,
            CommandAction::OpenSettings(Some(entry.clone())),
        )
        .detail(search_trail(&entry))
        .keywords(keywords)
        .search_only()
    }));
    out
}
