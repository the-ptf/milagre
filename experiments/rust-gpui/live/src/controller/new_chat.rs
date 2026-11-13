//! The controller's side of the new-Chat screen on Milagre's daemon ([`crate::new_chat`]): it fills the composer's
//! pickers from the reducer's state and the daemon's reads, and sends a new Chat's first message where the tray says.

use std::collections::{HashMap, HashSet};

use gpui::{App, Context, Global};
use milagre_gpui_spike::data::{PermissionMode, Provider};
use milagre_gpui_spike::workspace::chat::composer::new_chat::NewChatChoice;

use super::{Backend, Done, Job, LiveController};
use crate::new_chat::{self as live, Reads};

/// The daemon's reads per Project path, kept for the window's life and read again each time a new-Chat screen opens
/// (the last ones show meanwhile).
#[derive(Default)]
struct NewChatReads {
    done: HashMap<String, Reads>,
    reading: HashSet<String>,
    /// A new-Chat screen is up (a new one reads its Project again).
    open: bool,
    fresh: HashSet<String>,
}

impl Global for NewChatReads {}

impl LiveController {
    /// Follows the composer: on the new-Chat screen, its pickers list the loaded Projects and the picked Project's
    /// Worktrees, branches, base and Linear issues.
    pub(super) fn follow_new_chat(&mut self, cx: &mut Context<Self>) {
        let Backend::Daemon(daemon) = &self.backend else { return };
        let daemon = daemon.clone();
        let composer = self.workspace.read(cx).chat.read(cx).composer.clone();
        if composer.read(cx).new_chat().is_none() {
            cx.default_global::<NewChatReads>().open = false;
            return;
        }
        {
            let reads = cx.default_global::<NewChatReads>();
            if !reads.open {
                reads.open = true;
                reads.fresh.clear();
            }
        }
        let mut projects = self.store.read(|reducer| reducer.shown().map(|applied| applied.projects.clone()).unwrap_or_default());
        for open in &mut projects {
            open.project.image = daemon.image(&open.project.path);
        }
        // The Project the composer settles on (its own pick when listed, else the one asked for, else the first): its
        // lists are set all at once, so a redraw never sees another Project's.
        let listed = live::from_state(&projects, None);
        let Some(project) = composer.read(cx).new_chat_project_for(&listed).map(|p| p.to_string()) else {
            composer.update(cx, |c, cx| c.set_new_chat_options(listed, cx));
            return;
        };
        let mut options = live::from_state(&projects, Some(&project));
        let reads = cx.default_global::<NewChatReads>();
        if let Some(done) = reads.done.get(&project) {
            done.apply(&mut options);
        }
        let stale = !reads.fresh.contains(&project);
        if stale && reads.reading.insert(project.clone()) {
            cx.spawn(async move |this, cx| {
                let target = project.clone();
                let read = super::off_thread(move || futures::executor::block_on(live::read(&daemon, &target))).await.unwrap_or_default();
                let _ = this.update(cx, |this, cx| {
                    let reads = cx.default_global::<NewChatReads>();
                    reads.reading.remove(&project);
                    reads.fresh.insert(project.clone());
                    reads.done.insert(project, read);
                    this.follow_new_chat(cx);
                });
            })
            .detach();
        }
        composer.update(cx, |c, cx| c.set_new_chat_options(options, cx));
    }

    /// A new Chat's first message on Milagre's daemon: where the tray says (This checkout's Worktree, or a new one made
    /// first), with the picker's model, effort and permission mode. `None` when there is nothing to send to.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new_chat_job(
        &mut self,
        mut choice: NewChatChoice,
        text: String,
        queue: bool,
        mode: PermissionMode,
        effort: Option<&'static str>,
        model: (Provider, String),
        attachments: crate::sinks::Attachments,
        cx: &App,
    ) -> Option<Job> {
        let Backend::Daemon(daemon) = &self.backend else { return None };
        let daemon = daemon.clone();
        if choice.project.is_empty() {
            match self.new_chat_project(cx) {
                Some(project) => choice.project = project.into(),
                None => {
                    self.error("No Project to start the Chat in: nothing was sent".into());
                    return None;
                }
            }
        }
        self.sent += 1;
        let id = format!("gpui-{}-{}-{}", std::process::id(), crate::transcript::now_ms(), self.sent);
        let project = choice.project.to_string();
        let send = live::Send {
            text,
            client_id: id.clone(),
            provider: model.0.id(),
            model: model.1,
            mode: crate::sinks::wire_name(mode),
            effort: effort.map(str::to_owned),
            queue,
            attachments,
        };
        Some(Box::pin(async move {
            let (receipt, chat) = live::send(&daemon, choice, send).await?;
            Ok(Some(Done::Sent { id, receipt, open: chat.map(|chat| format!("{project}#{chat}")) }))
        }))
    }
}
