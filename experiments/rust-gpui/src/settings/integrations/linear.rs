//! Settings › Integrations › Linear (`LinearSettings` in `Settings.tsx`, `packages/shared/src/linear.ts`): the
//! daemon keeps the switch (phones share it) and this computer's connections, one per workspace.

use std::time::Duration;

use gpui::{AnyElement, Context, IntoElement, SharedString, div, prelude::*};

use super::IntegrationsView;
use crate::settings::group::{CheckboxRow, SettingRow, slug};
use crate::ui::{Button, ButtonVariant};

pub const LINEAR_TITLE: &str = "Linear";
pub const LINEAR_HINT: &str = "Start chats from Linear issues and see each Worktree's issue.";
pub const LINEAR_CONNECTING: &str = "Finish signing in to Linear in your browser.";
pub const LINEAR_MOVE_TO_STARTED_TITLE: &str = "Move issues to In Progress";
pub const LINEAR_MOVE_TO_STARTED_HINT: &str =
    "When a chat starts from an issue that hasn't started yet, move it to its team's first started status.";
pub const LINEAR_ADD_WORKSPACE: &str = "Add workspace";
pub const LINEAR_ADD_WORKSPACE_HINT: &str =
    "Opens a Linear sign-in of its own, so you can use another account. Signing in to a workspace already here signs it in again.";
pub const LINEAR_CONNECTING_WINDOW: &str = "Finish signing in in the Linear window, or use your browser instead.";
pub const LINEAR_USE_BROWSER: &str = "Use my browser instead";

/// How long the fixture's sign-in takes.
pub const CONNECT_MS: u64 = 1500;

/// A sign-in made before Milagre asked to change issues; signing in to it again (on the computer) grants that.
pub fn read_only_hint() -> &'static str {
    "Can't move issues yet. Sign in to this workspace again with Add workspace to allow it."
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workspace {
    pub id: String,
    pub organization: String,
    pub viewer: String,
    pub can_write: bool,
}

/// "Connected as Victor to Happier Gym", "Connected to 2 workspaces", "Not connected".
pub fn status_line(workspaces: &[Workspace]) -> String {
    match workspaces {
        [] => "Not connected".to_string(),
        [only] => format!("Connected as {} to {}", only.viewer, only.organization),
        more => format!("Connected to {} workspaces", more.len()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Connecting {
    Window,
    Browser,
}

/// The page's Linear state and the fixture standing in for `readLinearEnabled`, `connectLinear` and friends.
pub struct LinearState {
    pub enabled: bool,
    pub move_to_started: bool,
    pub workspaces: Vec<Workspace>,
    pub connecting: Option<Connecting>,
    pub error: Option<String>,
    attempt: u64,
    /// The next sign-in fails with this message (a test hook).
    pub fail_next: Option<String>,
    added: u32,
}

impl Default for LinearState {
    fn default() -> Self {
        Self {
            enabled: true,
            move_to_started: true,
            workspaces: vec![
                Workspace { id: "happier-gym".into(), organization: "Happier Gym".into(), viewer: "Victor Lucas".into(), can_write: true },
                Workspace { id: "rdplus".into(), organization: "RDPlus".into(), viewer: "Victor Lucas".into(), can_write: false },
            ],
            connecting: None,
            error: None,
            attempt: 0,
            fail_next: None,
            added: 0,
        }
    }
}

impl IntegrationsView {
    pub fn set_linear_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.linear.error = None;
        self.linear.enabled = enabled;
        cx.notify();
    }

    pub fn set_move_to_started(&mut self, on: bool, cx: &mut Context<Self>) {
        self.linear.error = None;
        self.linear.move_to_started = on;
        cx.notify();
    }

    pub fn disconnect_workspace(&mut self, id: &str, cx: &mut Context<Self>) {
        self.linear.error = None;
        self.linear.workspaces.retain(|workspace| workspace.id != id);
        cx.notify();
    }

    /// Connect again replaces a waiting sign-in; only the latest attempt may update the row.
    pub fn connect_linear(&mut self, in_window: bool, cx: &mut Context<Self>) {
        self.linear.attempt += 1;
        let attempt = self.linear.attempt;
        self.linear.error = None;
        self.linear.connecting = Some(if in_window { Connecting::Window } else { Connecting::Browser });
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(CONNECT_MS)).await;
            this.update(cx, |this, cx| {
                if this.linear.attempt != attempt {
                    return;
                }
                this.linear.connecting = None;
                match this.linear.fail_next.take() {
                    Some(message) => this.linear.error = Some(message),
                    None => {
                        this.linear.added += 1;
                        let n = this.linear.added;
                        this.linear.workspaces.push(Workspace {
                            id: format!("workspace-{n}"),
                            organization: format!("Workspace {n}"),
                            viewer: "Victor Lucas".into(),
                            can_write: true,
                        });
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The rows of the Linear group.
    pub(super) fn linear_rows(&self, highlighted: Option<&str>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let state = &self.linear;
        let mut rows: Vec<AnyElement> = Vec::new();
        rows.push(
            CheckboxRow::new("linear-enabled", LINEAR_TITLE, state.enabled)
                .description(LINEAR_HINT)
                .highlighted(highlighted)
                .on_change({
                    let page = cx.entity();
                    move |on, _, cx| page.update(cx, |this, cx| this.set_linear_enabled(on, cx))
                })
                .into_any_element(),
        );
        if !state.enabled {
            return rows;
        }
        for workspace in &state.workspaces {
            let id = workspace.id.clone();
            let mut description = format!("Signed in as {}", workspace.viewer);
            if state.move_to_started && !workspace.can_write {
                description.push_str(&format!(". {}", read_only_hint()));
            }
            let slug_id = slug(&workspace.id);
            rows.push(
                SettingRow::new(workspace.organization.clone())
                    .description(description)
                    .control(
                        Button::new(SharedString::from(format!("linear-disconnect-{slug_id}")), "Disconnect")
                            .variant(ButtonVariant::Secondary)
                            .on_click(cx.listener(move |this, _, _, cx| this.disconnect_workspace(&id, cx))),
                    )
                    .into_any_element(),
            );
        }
        let connected = !state.workspaces.is_empty();
        if connected {
            rows.push(
                CheckboxRow::new("linear-move-to-started", LINEAR_MOVE_TO_STARTED_TITLE, state.move_to_started)
                    .description(LINEAR_MOVE_TO_STARTED_HINT)
                    .highlighted(highlighted)
                    .on_change({
                        let page = cx.entity();
                        move |on, _, cx| page.update(cx, |this, cx| this.set_move_to_started(on, cx))
                    })
                    .into_any_element(),
            );
        }
        let label = if connected { LINEAR_ADD_WORKSPACE.to_string() } else { status_line(&state.workspaces) };
        let description = match state.connecting {
            Some(Connecting::Window) => Some(LINEAR_CONNECTING_WINDOW),
            Some(Connecting::Browser) => Some(LINEAR_CONNECTING),
            None if connected => Some(LINEAR_ADD_WORKSPACE_HINT),
            None => None,
        };
        let connect_in_window = match state.connecting {
            Some(way) => way == Connecting::Window,
            None => connected,
        };
        let mut controls = div().flex().flex_none().items_center().gap(gpui::px(8.0));
        if state.connecting == Some(Connecting::Window) {
            controls = controls.child(
                Button::new("linear-use-browser", LINEAR_USE_BROWSER)
                    .variant(ButtonVariant::Secondary)
                    .on_click(cx.listener(|this, _, _, cx| this.connect_linear(false, cx))),
            );
        }
        controls = controls.child(
            Button::new(
                "linear-connect",
                if state.connecting.is_some() {
                    "Start again"
                } else if connected {
                    "Add"
                } else {
                    "Connect"
                },
            )
            .variant(ButtonVariant::Secondary)
            .on_click(cx.listener(move |this, _, _, cx| this.connect_linear(connect_in_window, cx))),
        );
        let mut row = SettingRow::new(label.clone()).highlighted(highlighted).control(controls);
        if let Some(description) = description {
            row = row.description(description);
        }
        rows.push(row.into_any_element());
        rows
    }
}
