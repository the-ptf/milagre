//! The window's side of the overlays (WP-50): ⌘K, the commands it runs, and the dialogs the window opens
//! (`overlays::palette`, `overlays::dialogs`). It lives beside [`Workspace`] because it reads the sidebar, the Chat
//! column and the panel, and keeps their fields private.

use std::rc::Rc;

use gpui::{AnyWindowHandle, BorrowAppContext as _, Context, Window};

use super::Workspace;
use crate::data::{Data, LOCAL, PageRequest, ScopeKey, now};
use crate::overlays::dialogs::git_actions::{self, GENERATE_FOR, GitDialogConfig};
use crate::overlays::dialogs::git_fixture::{FixtureGit, Scenario};
use crate::overlays::dialogs::host::{NamedLink, PendingComputer};
use crate::overlays::dialogs::{self, Host};
use crate::overlays::palette::commands::{Command, CommandAction};
use crate::overlays::palette::{ChatEntry, FixtureMessages, MessageSearch, PaletteEvent, PaletteInput, ProjectEntry};
use crate::settings::SettingsStore;
use crate::settings::appearance::model::ThemePreference;
use crate::workspace::chat::ChatView;

impl Workspace {
    /// ⌘K: opens the palette, or closes it when it is open.
    pub(super) fn toggle_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.read(cx).is_open() {
            self.palette.update(cx, |palette, cx| palette.close(cx));
            return;
        }
        let input = self.palette_input(cx);
        let search = self.message_search(cx);
        self.palette.update(cx, |palette, cx| palette.show(&input, Some(search), window, cx));
    }

    /// What the palette lists: the sidebar's Chats, the other Projects of this computer, and where the window is.
    fn palette_input(&self, cx: &Context<Self>) -> PaletteInput {
        let sidebar = self.sidebar.read(cx);
        let chats = (0..sidebar.row_count())
            .filter_map(|ix| sidebar.row(ix))
            .map(|row| ChatEntry { key: row.key.to_string(), title: row.title.to_string(), mark: row.mark, detail: row.detail.to_string() })
            .collect();
        let source = cx.global::<Data>().0.clone();
        let current = now(source.current_project()).ok().flatten().map(|open| open.project.path);
        let projects = now(source.recent_projects(LOCAL.into()))
            .unwrap_or_default()
            .into_iter()
            .filter(|project| !project.hidden && !project.is_chats_home() && Some(&project.path) != current.as_ref())
            .map(|project| ProjectEntry { path: project.path.to_string(), name: project.name.to_string() })
            .collect();
        PaletteInput {
            chats,
            projects,
            current_chat: self.chat.read(cx).key().is_some(),
            git: true,
            away_from_chat: self.routines_open || self.settings.read(cx).is_open(),
        }
    }

    /// The words in the Chats' messages, read once from the data source and searched as the host would.
    fn message_search(&mut self, cx: &Context<Self>) -> Rc<dyn MessageSearch> {
        let source = cx.global::<Data>().0.clone();
        let sidebar = self.sidebar.read(cx);
        let mut messages = Vec::new();
        for ix in 0..sidebar.row_count() {
            let Some(row) = sidebar.row(ix) else { continue };
            let Some((scope, id)) = row.key.rsplit_once('#') else { continue };
            let Ok(chat) = id.parse::<u64>() else { continue };
            if let Ok(page) = now(source.chat_messages(ScopeKey(scope.to_string().into()), chat, PageRequest::OPEN)) {
                messages.extend(page.messages.iter().map(|message| (row.key.to_string(), message.id, message.body.to_string())));
            }
        }
        Rc::new(FixtureMessages::new(messages))
    }

    /// The palette closed on a command: carry it out once focus has settled.
    pub(super) fn on_palette_event(&mut self, event: &PaletteEvent, window: &mut Window, cx: &mut Context<Self>) {
        if let PaletteEvent::Closed = event {
            // Back to what had the focus; the window itself when nothing did.
            let focus = self.palette.update(cx, |palette, _| palette.take_previous_focus());
            window.focus(&focus.unwrap_or_else(|| self.focus.clone()), cx);
        }
        if let PaletteEvent::Run(command) = event {
            let command = (**command).clone();
            let this = cx.entity();
            window.defer(cx, move |window, cx| this.update(cx, |this, cx| this.run_command(&command, window, cx)));
        }
    }

    pub fn run_command(&mut self, command: &Command, window: &mut Window, cx: &mut Context<Self>) {
        match &command.action {
            CommandAction::NewChat => self.start_new_chat(None, window, cx),
            CommandAction::StartChat(draft) => self.start_new_chat(Some(draft), window, cx),
            CommandAction::AddProject => self.open_add_project(window, cx),
            CommandAction::OpenRoutines => {
                self.open_routines(cx);
                // The Chat column and its composer are gone: the window keeps the keys.
                window.focus(&self.focus.clone(), cx);
            }
            CommandAction::OpenSettings(entry) => {
                let entry = entry.clone();
                self.settings.update(cx, |settings, cx| {
                    settings.open(window, cx);
                    if let Some(entry) = &entry {
                        settings.open_search_entry(entry, cx);
                    }
                });
            }
            CommandAction::ToggleTheme => cx.update_global::<SettingsStore, _>(|store, _| {
                store.appearance.theme = match store.appearance.theme {
                    ThemePreference::Dark => ThemePreference::Light,
                    _ => ThemePreference::Dark,
                };
            }),
            CommandAction::BackToChat => {
                self.routines_open = false;
                self.settings.update(cx, |settings, cx| settings.close(window, cx));
                cx.notify();
            }
            CommandAction::OpenGitActions => self.open_git_actions(window, cx),
            CommandAction::OpenChat(key) | CommandAction::OpenMessage { chat: key, .. } => self.open_chat(key, cx),
            CommandAction::OpenProject(path) => self.open_project(path, cx),
            CommandAction::SetSetting(setting) => cx.update_global::<SettingsStore, _>(|store, _| setting.apply(store)),
        }
    }

    fn start_new_chat(&mut self, draft: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        self.routines_open = false;
        self.chat.update(cx, |chat, cx| {
            chat.composer.update(cx, |composer, cx| {
                composer.start_new_chat(cx);
                if let Some(draft) = draft {
                    composer.prefill(draft, window, cx);
                }
            })
        });
        cx.notify();
    }

    fn open_chat(&mut self, key: &str, cx: &mut Context<Self>) {
        self.routines_open = false;
        self.sidebar.update(cx, |sidebar, cx| sidebar.select_key(key, cx));
        cx.notify();
    }

    /// Another Project: its first Chat (a row says its Project first in its detail line).
    fn open_project(&mut self, path: &str, cx: &mut Context<Self>) {
        let source = cx.global::<Data>().0.clone();
        let name = now(source.recent_projects(LOCAL.into())).ok().and_then(|all| all.into_iter().find(|p| p.path == path)).map(|p| p.name);
        let Some(name) = name else { return };
        let key = {
            let sidebar = self.sidebar.read(cx);
            (0..sidebar.row_count())
                .filter_map(|ix| sidebar.row(ix))
                .find(|row| row.detail.starts_with(name.as_ref()))
                .map(|row| row.key.to_string())
        };
        if let Some(key) = key {
            self.open_chat(&key, cx);
        }
    }

    /// "Commit and open PR…" over the open Chat (`openGitDialog`). "Send to agent" sends the failure to this Chat.
    pub fn open_git_actions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let handle: AnyWindowHandle = window.window_handle();
        let chat = self.chat.clone();
        let project = self.chat.read(cx).project().to_string();
        let config = GitDialogConfig {
            project_name: (!project.is_empty()).then_some(project),
            bridge: Rc::new(FixtureGit::new(Scenario::Ready)),
            turn_running: false,
            // The note the dialog leaves in the Chat waits for the host's `addGitNote`.
            on_ran: Rc::new(|_, _| {}),
            on_send: Rc::new(move |text, cx| {
                let chat = chat.clone();
                handle.update(cx, move |_, window, cx| send_to_chat(&chat, &text, window, cx)).ok();
            }),
        };
        git_actions::open(config, Some(GENERATE_FOR), window, cx);
    }

    /// "Fix in Chat" on a PR thread: the ask goes out like any send, and the draft stays (`sendPrToChat`).
    pub(super) fn fix_in_chat(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.routines_open = false;
        send_to_chat(&self.chat.clone(), text, window, cx);
    }
}

/// Sends `text` through the open Chat's composer, keeping its draft.
fn send_to_chat(chat: &gpui::Entity<ChatView>, text: &str, window: &mut Window, cx: &mut gpui::App) {
    let composer = chat.read(cx).composer.clone();
    composer.update(cx, |composer, cx| composer.send_text(text, window, cx));
}

// ---- The dialogs the window opens (WP-50) ----

impl Workspace {
    fn computers(&self, cx: &Context<Self>) -> (String, Vec<crate::data::Computer>) {
        match now(cx.global::<Data>().0.computers()) {
            Ok(snapshot) => (snapshot.this_mac.to_string(), snapshot.computers),
            Err(_) => (String::new(), Vec::new()),
        }
    }

    /// Add Project: this computer or a paired one; the new Project's first Chat opens once the sidebar knows it.
    pub fn open_add_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (this_mac, computers) = self.computers(cx);
        let this_mac = if this_mac.is_empty() { "This computer".to_string() } else { this_mac };
        dialogs::add_project::open(self.dialog_host.clone(), &this_mac, computers, |_, _| {}, window, cx);
    }

    /// Add computer: paste a pairing link.
    pub fn open_add_computer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        dialogs::add_computer::open(self.dialog_host.clone(), |_, _| {}, window, cx);
    }

    /// Link Projects, or Edit Link for `link`; "Delete Link…" in the edit asks for its confirmation.
    pub fn open_link_projects(&mut self, link: Option<NamedLink>, window: &mut Window, cx: &mut Context<Self>) {
        let host = self.dialog_host.clone();
        let for_delete = host.clone();
        let on_delete: Option<dialogs::link_projects::DeleteLink> = link.as_ref().map(|_| {
            std::rc::Rc::new(move |link: &NamedLink, window: &mut Window, cx: &mut gpui::App| {
                crate::ui::Dialog::close(window, cx);
                dialogs::delete_link::open(link.clone(), "this computer", for_delete.clone(), |_, _, _| {}, window, cx);
            }) as dialogs::link_projects::DeleteLink
        });
        dialogs::link_projects::open(link, host, |_, _| {}, on_delete, window, cx);
    }

    /// Remove Project: confirm forgetting `path`.
    pub fn open_remove_project(&mut self, path: &str, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        dialogs::remove_project::open((path, name), self.dialog_host.clone(), |_, _| {}, window, cx);
    }

    /// The computers waiting to drive this one (`devices:pending`): the allow prompt follows the list.
    pub fn set_pending_computers(&mut self, requests: Vec<PendingComputer>, window: &mut Window, cx: &mut Context<Self>) {
        self.allow_prompt.update(cx, |prompt, cx| prompt.set_requests(requests, window, cx));
    }

    /// What's new for `version`.
    pub fn open_release_notes(&mut self, version: &str, window: &mut Window, cx: &mut Context<Self>) {
        dialogs::release_notes::open(version, self.dialog_host.clone(), window, cx);
    }

    /// The brief of a provider handoff, or a Link's summary.
    pub fn open_handoff_brief(&mut self, title: &str, brief: &str, window: &mut Window, cx: &mut Context<Self>) {
        dialogs::handoff_brief::open(title.to_string(), brief, window, cx);
    }

    /// Quitting could not save the Chats.
    pub fn open_quit_error(&mut self, message: &str, window: &mut Window, cx: &mut Context<Self>) {
        dialogs::quit_error::open(message.to_string(), self.dialog_host.clone(), window, cx);
    }

    /// Snapshot runs: `MILAGRE_GPUI_PALETTE=<query>` opens ⌘K with that text once the window has drawn, and
    /// `MILAGRE_GPUI_DIALOG=<name>[,<state>]` opens a dialog (`dialogs::open_from_env`).
    pub(super) fn open_overlay_from_env(window: &mut Window, cx: &mut Context<Self>) {
        // Once: from the first frame, so a snapshot (which stops drawing early) has the overlay in it.
        static ONCE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if ONCE.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let palette = std::env::var("MILAGRE_GPUI_PALETTE").ok();
        let dialog = std::env::var("MILAGRE_GPUI_DIALOG").ok();
        if palette.is_none() && dialog.is_none() {
            return;
        }
        let this = cx.weak_entity();
        window.defer(cx, move |window, cx| {
            this.update(cx, |this, cx| {
                if let Some(query) = palette {
                    this.toggle_palette(window, cx);
                    this.palette.update(cx, |palette, cx| palette.set_query(&query, window, cx));
                }
                if let Some(spec) = dialog {
                    // Opened from a deferred call, as the Git dialog's snapshot hook is: not inside a draw.
                    let weak = cx.weak_entity();
                    window.defer(cx, move |window, cx| {
                        weak.update(cx, |this, cx| dialogs::open_from_env(&spec, this, window, cx)).ok();
                    });
                }
            })
            .ok();
        });
    }

    pub(crate) fn dialog_host(&self) -> Host {
        self.dialog_host.clone()
    }

    pub(crate) fn allow_prompt(&self) -> &gpui::Entity<dialogs::allow_prompt::ComputerAllowPrompt> {
        &self.allow_prompt
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::TestAppContext;

    use crate::overlays::OpenGitActions;
    use crate::testing;
    use crate::workspace::chat::composer::ComposerEvent;
    use crate::workspace::panel::PanelEvent;

    #[gpui::test]
    fn fix_in_chat_sends_the_thread_to_the_open_chat_and_keeps_the_draft(cx: &mut TestAppContext) {
        let (workspace, cx) = testing::mount_workspace(cx);
        let composer = workspace.read_with(cx, |w, cx| w.chat.read(cx).composer.clone());
        let sent = Rc::new(RefCell::new(Vec::new()));
        let seen = sent.clone();
        let _sub = cx.update(|_, cx| {
            cx.subscribe(&composer, move |_, event: &ComposerEvent, _| {
                if let ComposerEvent::Send(text) = event {
                    seen.borrow_mut().push(text.to_string());
                }
            })
        });
        cx.update(|window, cx| composer.update(cx, |composer, cx| composer.set_text("half a thought", window, cx)));
        let panel = workspace.read_with(cx, |w, _| w.panel.clone());
        cx.update(|_, cx| panel.update(cx, |_, cx| cx.emit(PanelEvent::FixInChat("Address this review thread on PR #412".into()))));
        cx.run_until_parked();
        assert_eq!(*sent.borrow(), ["Address this review thread on PR #412"], "it goes out like any send");
        assert_eq!(composer.read_with(cx, |c, _| c.text().to_string()), "half a thought", "what was typed stays");
    }

    #[gpui::test]
    fn the_git_actions_action_opens_the_dialog_over_the_chat(cx: &mut TestAppContext) {
        let (workspace, cx) = testing::mount_workspace(cx);
        let focus = workspace.read_with(cx, |w, cx| w.chat.read(cx).composer_focus_handle(cx));
        cx.update(|window, cx| window.focus(&focus, cx));
        assert!(cx.debug_bounds("git-dialog").is_none());
        cx.update(|window, cx| window.dispatch_action(Box::new(OpenGitActions), cx));
        cx.run_until_parked();
        for _ in 0..3 {
            cx.update(|window, _| window.refresh());
            cx.run_until_parked();
        }
        assert!(cx.debug_bounds("git-dialog").is_some());
    }

    #[gpui::test]
    fn start_a_chat_with_the_search_puts_it_in_the_composer(cx: &mut TestAppContext) {
        use crate::overlays::palette::commands::{Command, CommandAction, CommandIcon};
        let (workspace, cx) = testing::mount_workspace(cx);
        let command =
            Command::new("x", "Start", "New Chat", CommandIcon::NewChat, CommandAction::StartChat("why is the relay slow".into()));
        cx.update(|window, cx| workspace.update(cx, |w, cx| w.run_command(&command, window, cx)));
        cx.run_until_parked();
        let composer = workspace.read_with(cx, |w, cx| w.chat.read(cx).composer.clone());
        assert_eq!(composer.read_with(cx, |c, _| c.text().to_string()), "why is the relay slow");
        assert!(composer.read_with(cx, |c, _| c.new_chat().is_some()), "the new-Chat tray is on");
    }
}
