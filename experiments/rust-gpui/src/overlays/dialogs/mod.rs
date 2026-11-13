//! The dialogs of the app, one file each.
//!
//! | File | Surface | Desktop |
//! | --- | --- | --- |
//! | `git_actions.rs` | "Commit and open PR" (P-10); `git_dialog.rs` holds its rules, `git_fixture.rs` its fixture folders | `GitActionsDialog.tsx`, `lib/git-dialog.ts` |
//! | `add_computer.rs` | Add computer (O-06): pairing link, preview, name, wait for Allow | `AddComputerDialog.tsx` |
//! | `add_project.rs` | Add Project (O-07): this computer or a paired one, open a folder or clone, the folder browser | `AddProjectDialog.tsx` |
//! | `link_projects.rs` | Link Projects / Edit Link (O-08): name and a checklist of Projects | `LinkProjectDialog.tsx` |
//! | `remove_project.rs` | Remove Project (O-09) | `RemoveProjectDialog.tsx` |
//! | `delete_link.rs` | Delete Link (O-10): blocked while its Chats run, rechecked every 2 s | `DeleteLinkDialog.tsx` |
//! | `allow_prompt.rs` | The computer allow prompt (O-11): must be answered, armed after 500 ms | `ComputerAllowPrompt.tsx` |
//! | `release_notes.rs` | What's new (O-12) | `UpdateReleaseNotes.tsx` |
//! | `handoff_brief.rs` | The handoff brief (O-13) | `Handover.tsx` `HandoffBriefDialog` |
//! | `quit_error.rs` | "Chats could not be saved" (O-14) | `App.tsx` |
//! | `project_chooser.rs` | No Project open, or the open failed with Retry (O-05) | `App.tsx` |
//! | `copy.rs`, `host.rs` | the shared words and rules; the host calls and their fixture | `worktree-link.mjs`, `pending-computers.ts`, `handover.ts` |
//!
//! Each opens through [`crate::ui::Dialog`] over a view of its own that draws the body and the footer buttons
//! (`ui::Dialog` builds its action row once, so a button that changes label or turns off while it works is the
//! view's). Calls to the host go through [`call`], which waits a [`STEP`] first so a busy state is seen.
//!
//! Not built in any of them: the 28px close button, the dialog keeping Escape and the scrim live while a call is
//! under way (`ui::Dialog` cannot change that once open), and autofocus on the Cancel button.

pub mod add_computer;
pub mod add_project;
pub mod allow_prompt;
pub mod copy;
pub mod delete_link;
pub mod git_actions;
pub mod git_dialog;
pub mod git_fixture;
pub mod handoff_brief;
pub mod host;
pub mod link_projects;
pub mod project_chooser;
pub mod quit_error;
pub mod release_notes;
pub mod remove_project;

#[cfg(test)]
mod tests;

use std::rc::Rc;
use std::time::Duration;

use gpui::{AnyElement, Context, FontWeight, IntoElement, SharedString, Task, Window, div, prelude::*, px};

use crate::data::DataFuture;
use crate::theme::{TEXT_12, TEXT_13, TextStepExt, Theme};

pub use host::{DialogHost, FixtureHost};

/// The host the dialogs call.
pub type Host = Rc<dyn DialogHost>;

/// How long a fixture call takes, so "Removing…" and "Connecting…" are on screen.
pub const STEP: Duration = Duration::from_millis(250);

/// Runs a host call after `delay` and hands its answer to `apply` on the view (`window` for closing the dialog).
pub(crate) fn call<V: 'static, T: Send + 'static>(
    window: &mut Window,
    cx: &mut Context<V>,
    delay: Duration,
    future: DataFuture<T>,
    apply: impl FnOnce(&mut V, anyhow::Result<T>, &mut Window, &mut Context<V>) + 'static,
) -> Task<()> {
    cx.spawn_in(window, async move |this, cx| {
        if !delay.is_zero() {
            cx.background_executor().timer(delay).await;
        }
        let result = future.await;
        this.update_in(cx, |view, window, cx| apply(view, result, window, cx)).ok();
    })
}

/// A field's label (`FIELD_LABEL`: 12 medium `ink-2`).
pub(crate) fn field_label(text: impl Into<SharedString>, theme: &Theme) -> AnyElement {
    div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(text.into()).into_any_element()
}

/// The dialog's description line under the title, for a body that has to change with the dialog's state.
pub(crate) fn description_line(text: impl Into<SharedString>, theme: &Theme) -> AnyElement {
    div().text_step(TEXT_13).text_color(theme.ink2).child(text.into()).into_any_element()
}

/// The row of buttons at the bottom, right-aligned; `lead` sits at the left (a status, "Delete Link…").
pub(crate) fn footer(lead: Option<AnyElement>, buttons: Vec<AnyElement>) -> AnyElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_end()
        .gap(px(8.0))
        .when_some(lead, |row, lead| row.child(div().min_w_0().mr_auto().flex_1().child(lead)))
        .children(buttons)
        .into_any_element()
}

/// Snapshot runs: `MILAGRE_GPUI_DIALOG=<name>[,<state>]` opens one of these on the window, in the state named:
///
/// | Name | States |
/// | --- | --- |
/// | `add-computer` | `link` (a link typed, the computer found), `waiting` (paired, waiting for Allow) |
/// | `add-project` | `remote` (a paired computer's folders), `clone`, `offline` (its computer is off) |
/// | `link`, `link-edit` | |
/// | `remove` | `error` |
/// | `delete-link` | `running` (a Chat holds the delete) |
/// | `allow` | `two` (a second request waits) |
/// | `notes` | `failed`, `empty` |
/// | `brief`, `quit-error` | |
pub fn open_from_env(
    spec: &str,
    workspace: &mut crate::workspace::Workspace,
    window: &mut Window,
    cx: &mut Context<crate::workspace::Workspace>,
) {
    use host::{NamedLink, PendingComputer};
    let mut parts = spec.split(',');
    let name = parts.next().unwrap_or_default();
    let state = parts.next().unwrap_or_default();
    let host = workspace.dialog_host();
    let fixture = FixtureHost::new();
    match name {
        "add-computer" => {
            let dialog = add_computer::open(host, |_, _| {}, window, cx);
            if matches!(state, "link" | "waiting") {
                let link = "milagre://pair?relay=https%3A%2F%2Frelay.milagre.cloud&host=h1&key=k&token=0&name=Studio+Mac".to_string();
                dialog.update(cx, |dialog, cx| {
                    dialog.link_input().update(cx, |input, cx| input.set_value(link, window, cx));
                });
                if state == "waiting" {
                    window.defer(cx, move |window, cx| dialog.update(cx, |dialog, cx| dialog.add(window, cx)));
                }
            }
        }
        "add-project" => {
            let (this_mac, computers) = {
                let snapshot = crate::data::now(cx.global::<crate::data::Data>().0.computers()).unwrap_or_default();
                (snapshot.this_mac.to_string(), snapshot.computers)
            };
            let dialog = add_project::open(host, &this_mac, computers.clone(), |_, _| {}, window, cx);
            let online = computers.iter().find(|computer| computer.state == crate::data::ComputerState::Online).map(|c| c.id.to_string());
            let away = computers.iter().find(|computer| computer.state != crate::data::ComputerState::Online).map(|c| c.id.to_string());
            match (state, online, away) {
                ("remote", Some(id), _) => dialog.update(cx, |dialog, cx| {
                    dialog.choose_computer(&id, window, cx);
                    dialog.browse(Some("/Users/dev/Code".into()), window, cx);
                }),
                ("offline", _, Some(id)) => dialog.update(cx, |dialog, cx| {
                    let _ = id;
                    dialog.set_mode(add_project::Mode::Open, cx);
                }),
                ("clone", _, _) => dialog.update(cx, |dialog, cx| dialog.set_mode(add_project::Mode::Clone, cx)),
                _ => {}
            }
        }
        "link" => {
            link_projects::open(None, host, |_, _| {}, None, window, cx);
        }
        "link-edit" => {
            let link = NamedLink {
                id: "link-1".into(),
                name: "RDFood".into(),
                project_ids: vec!["/Users/dev/Code/rd-mobile".into(), "/Users/dev/Code/rd-food".into()],
            };
            link_projects::open(Some(link), host, |_, _| {}, Some(Rc::new(|_, _, _| {})), window, cx);
        }
        "remove" => {
            if state == "error" {
                fixture.with(|s| s.fail_next = Some("Could not reach the host.".into()));
            }
            let host: Host = if state == "error" { Rc::new(fixture) } else { host };
            let dialog = remove_project::open(("/Users/dev/Code/milagre-ade", "milagre-ade"), host, |_, _| {}, window, cx);
            if state == "error" {
                window.defer(cx, move |window, cx| dialog.update(cx, |dialog, cx| dialog.remove(window, cx)));
            }
        }
        "delete-link" => {
            fixture.with(|s| s.running_checks = if state == "running" { usize::MAX } else { 0 });
            let link = NamedLink { id: "link-1".into(), name: "RDFood".into(), project_ids: Vec::new() };
            delete_link::open(link, "this computer", Rc::new(fixture), |_, _, _| {}, window, cx);
        }
        "allow" => {
            let mut requests = vec![PendingComputer { key: "a".into(), name: Some("Studio Mac".into()) }];
            if state == "two" {
                requests.push(PendingComputer { key: "b".into(), name: None });
            }
            let prompt = workspace.allow_prompt().clone();
            prompt.update(cx, |prompt, cx| prompt.set_requests(requests, window, cx));
        }
        "notes" => {
            match state {
                "failed" => {
                    fixture.with(|s| s.fail_next = Some("offline".into()));
                }
                "empty" => {
                    fixture.with(|s| s.notes = Some(String::new()));
                }
                _ => {}
            }
            release_notes::open("0.232.0", Rc::new(fixture), window, cx);
        }
        "brief" => {
            handoff_brief::open(
                "Handoff brief",
                "## Where we are\n\nThe palette lists Chats, Projects and actions.\n\n- Open question: how recent commands persist.\n- Next: the Link dialog.\n\n```sh\ncargo test\n```",
                window,
                cx,
            );
        }
        "quit-error" => {
            quit_error::open("ENOSPC: no space left on device, write '/Users/dev/.milagre/chats.db'", host, window, cx);
        }
        _ => {}
    }
}
