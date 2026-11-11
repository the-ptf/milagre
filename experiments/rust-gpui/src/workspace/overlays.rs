//! The window's side of the overlays (WP-50): the Git actions dialog and "Fix in Chat". It lives beside
//! [`Workspace`] because it reads the Chat column, and keeps its fields private.

use std::rc::Rc;

use gpui::{AnyWindowHandle, Context, Window};

use super::Workspace;
use crate::overlays::dialogs::git_actions::{self, GENERATE_FOR, GitDialogConfig};
use crate::overlays::dialogs::git_fixture::{FixtureGit, Scenario};
use crate::workspace::chat::ChatView;

impl Workspace {
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
}
