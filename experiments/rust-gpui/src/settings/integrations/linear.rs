//! Settings › Integrations › Linear (`LinearSettings` in `Settings.tsx`, `packages/shared/src/linear.ts`): the
//! daemon keeps the switch (phones share it) and this computer's connections, one per workspace.

use std::time::Duration;

use gpui::{AnyElement, Context, IntoElement, SharedString, div, prelude::*};
use serde_json::json;

use super::IntegrationsView;
use crate::settings::group::{CheckboxRow, SettingRow, slug};
use crate::settings::host;
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
/// What a sign-in replaced by a newer one fails with (`LINEAR_SIGN_IN_REPLACED`); the row going back says enough.
pub const LINEAR_SIGN_IN_REPLACED: &str = "Replaced by a newer Linear sign-in.";

/// How long the fixture's sign-in takes.
pub const CONNECT_MS: u64 = 1500;
/// While a host's sign-in waits for the browser, `linear:status` is read this often, for as long as the host waits
/// (five minutes and a half, `linear:connect`'s deadline in `apps/daemon/src/client.cjs`).
pub const SIGN_IN_POLL_MS: u64 = 2000;
pub const SIGN_IN_POLLS: u32 = 165;

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

/// `linearWorkspaces`: the connected workspaces of a `linear:status` answer, oldest first, also from a host that
/// predates workspaces (one `organization` and `viewer`).
pub fn workspaces_of(status: &serde_json::Value) -> Vec<Workspace> {
    let workspace = |item: &serde_json::Value, id: String| Workspace {
        id,
        organization: item["organization"]["name"].as_str().unwrap_or_default().to_string(),
        viewer: item["viewer"]["name"].as_str().unwrap_or_default().to_string(),
        can_write: item["canWrite"] != false,
    };
    if let Some(list) = status["workspaces"].as_array() {
        return list.iter().filter_map(|item| Some(workspace(item, item["id"].as_str()?.to_string()))).collect();
    }
    if status["connected"] == true {
        let id = status["organization"]["urlKey"].as_str().unwrap_or_default().to_lowercase();
        return vec![workspace(status, id)];
    }
    Vec::new()
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

impl LinearState {
    /// Off with no workspace, until the host's first answer.
    pub fn unread() -> Self {
        Self { enabled: false, workspaces: Vec::new(), ..Self::default() }
    }
}

impl IntegrationsView {
    /// A sign-in ended with `status`: the row goes back to Add and shows the new workspace.
    fn finish_sign_in(&mut self, attempt: u64, status: &serde_json::Value) {
        if self.linear.attempt == attempt {
            self.linear.connecting = None;
            self.linear.error = None;
            self.linear.workspaces = workspaces_of(status);
        }
    }

    /// Reads Linear from the host (`linear:enabled:read`, `linear:status`), as `LinearSettings` does when it mounts.
    pub(super) fn read_linear(&mut self, cx: &mut Context<Self>) {
        if let Some(task) = host::call("linear:enabled:read", json!([]), cx) {
            cx.spawn(async move |this, cx| {
                let answer = task.await;
                this.update(cx, |this, cx| {
                    match answer {
                        Ok(value) => {
                            this.linear.enabled = value["enabled"] == true;
                            this.linear.move_to_started = value["moveToStarted"] != false;
                        }
                        Err(_) => this.linear.enabled = false,
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        if let Some(task) = host::call("linear:status", json!([]), cx) {
            cx.spawn(async move |this, cx| {
                let answer = task.await;
                this.update(cx, |this, cx| {
                    this.linear.workspaces = answer.map(|status| workspaces_of(&status)).unwrap_or_default();
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
    }

    /// A switch saved on the host: shown at once, then as the host answered, or put back with why.
    fn save_switch(&mut self, method: &'static str, key: &'static str, on: bool, cx: &mut Context<Self>) {
        let Some(task) = host::call(method, json!([on]), cx) else { return };
        cx.spawn(async move |this, cx| {
            let answer = task.await;
            this.update(cx, |this, cx| {
                let value = match answer {
                    Ok(value) => value[key].as_bool().unwrap_or(on),
                    Err(message) => {
                        this.linear.error = Some(message);
                        !on
                    }
                };
                match key {
                    "enabled" => this.linear.enabled = value,
                    _ => this.linear.move_to_started = value,
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn set_linear_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.linear.error = None;
        self.linear.enabled = enabled;
        cx.notify();
        self.save_switch("linear:enabled:save", "enabled", enabled, cx);
    }

    pub fn set_move_to_started(&mut self, on: bool, cx: &mut Context<Self>) {
        self.linear.error = None;
        self.linear.move_to_started = on;
        cx.notify();
        self.save_switch("linear:move-to-started:save", "moveToStarted", on, cx);
    }

    pub fn disconnect_workspace(&mut self, id: &str, cx: &mut Context<Self>) {
        self.linear.error = None;
        if let Some(task) = host::call("linear:disconnect", json!([{"workspace": id}]), cx) {
            cx.spawn(async move |this, cx| {
                let answer = task.await;
                this.update(cx, |this, cx| {
                    match answer {
                        Ok(status) => this.linear.workspaces = workspaces_of(&status),
                        Err(message) => this.linear.error = Some(message),
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
            return;
        }
        self.linear.workspaces.retain(|workspace| workspace.id != id);
        cx.notify();
    }

    /// Connect again replaces a waiting sign-in; only the latest attempt may update the row. On a host the sign-in
    /// always opens in the system browser (`linear:connect [{window: false}]`: the host opens it); this window has no
    /// sign-in window of its own.
    pub fn connect_linear(&mut self, in_window: bool, cx: &mut Context<Self>) {
        self.linear.attempt += 1;
        let attempt = self.linear.attempt;
        self.linear.error = None;
        if let Some(task) = host::call("linear:connect", json!([{"window": false}]), cx) {
            self.linear.connecting = Some(Connecting::Browser);
            cx.notify();
            let known = self.linear.workspaces.len();
            cx.spawn(async move |this, cx| {
                let answer = task.await;
                this.update(cx, |this, cx| {
                    if this.linear.attempt != attempt {
                        return;
                    }
                    match answer {
                        Ok(status) => this.finish_sign_in(attempt, &status),
                        // The host still waits for the browser past this window's request deadline: the status
                        // follow-up below sees it finish.
                        Err(message) if message.contains("TimedOut") => return,
                        Err(message) if message.contains(LINEAR_SIGN_IN_REPLACED) => this.linear.connecting = None,
                        Err(message) => {
                            this.linear.connecting = None;
                            this.linear.error = Some(message);
                        }
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
            // `onLinearStatusChanged`: a status with more workspaces than when the sign-in started finishes it.
            cx.spawn(async move |this, cx| {
                for _ in 0..SIGN_IN_POLLS {
                    cx.background_executor().timer(Duration::from_millis(SIGN_IN_POLL_MS)).await;
                    let Ok(Some(task)) = this.update(cx, |this, cx| {
                        let waiting = this.linear.attempt == attempt && this.linear.connecting.is_some();
                        waiting.then(|| host::call("linear:status", json!([]), cx)).flatten()
                    }) else {
                        return;
                    };
                    let Ok(status) = task.await else { continue };
                    if workspaces_of(&status).len() > known {
                        this.update(cx, |this, cx| {
                            if this.linear.attempt == attempt {
                                this.finish_sign_in(attempt, &status);
                                cx.notify();
                            }
                        })
                        .ok();
                        return;
                    }
                }
            })
            .detach();
            return;
        }
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
