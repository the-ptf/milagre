//! Milagre MCP, under Settings › MCP (`LocalMcpSettings.tsx`, `use-local-mcp.ts`): the local MCP clients that can
//! reach Milagre, each with a scoped connection, and custom connections whose credential is shown once. The
//! fixture [`LocalHost`] plays the computer's `local-mcp:*` commands.

use std::time::Duration;

use gpui::{
    AnyElement, App, ClipboardItem, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription,
    Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

use super::Adapt as _;
use super::local_logic::{
    Cap, Client, ClientState, Configuration, Connection, Credential, Draft, DraftKind, Grants, Paths, ProjectGrant, client_config,
    client_detail, description, read_only,
};
use crate::settings::group::slug;
use crate::theme::{ActiveTheme, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, Checkbox, InlineError, Input, RadioGroup, RadioOption};

/// How long the fixture's commands take.
pub const BUSY_MS: u64 = 120;
/// The fixture's "now", for expiry.
pub const NOW: &str = "2026-11-11T12:00:00Z";

#[derive(Clone, Debug)]
pub struct LocalHost {
    pub clients: Vec<Client>,
    pub connections: Vec<Connection>,
    pub projects: Vec<(String, String)>,
    pub designs_on: bool,
    next: u32,
}

impl LocalHost {
    pub fn fixture(projects: Vec<(String, String)>) -> Self {
        let all_read = |paths: Paths, write: bool| Grants {
            projects: Some(ProjectGrant { paths: paths.clone(), caps: vec![Cap::Read] }),
            worktrees: Some(ProjectGrant {
                paths: paths.clone(),
                caps: if write { vec![Cap::Read, Cap::Create] } else { vec![Cap::Read] },
            }),
            chats: Some(ProjectGrant { paths, caps: if write { vec![Cap::Read, Cap::Create, Cap::Start] } else { vec![Cap::Read] } }),
            designs: None,
        };
        let first_two: Vec<String> = projects.iter().take(2).map(|(path, _)| path.clone()).collect();
        let code = Connection {
            id: "conn-claude-code".into(),
            config: Configuration { label: "Claude Code".into(), grants: all_read(Paths::Some(first_two), true), expires_at: None },
            revision: 1,
            revoked_at: None,
            client_id: Some("claude-code".into()),
        };
        let notes = Connection {
            id: "conn-notes".into(),
            config: Configuration { label: "Obsidian notes".into(), grants: all_read(Paths::All, true), expires_at: None },
            revision: 2,
            revoked_at: None,
            client_id: None,
        };
        let old = Connection {
            id: "conn-ci".into(),
            config: Configuration {
                label: "CI dashboard".into(),
                grants: all_read(Paths::All, false),
                expires_at: Some("2026-11-01T00:00:00Z".into()),
            },
            revision: 1,
            revoked_at: None,
            client_id: None,
        };
        let revoked = Connection {
            id: "conn-old".into(),
            config: Configuration { label: "Old script".into(), grants: all_read(Paths::All, false), expires_at: None },
            revision: 1,
            revoked_at: Some("2026-10-20T09:00:00Z".into()),
            client_id: None,
        };
        let client = |id: &str,
                      label: &str,
                      path: &str,
                      enabled: bool,
                      state: ClientState,
                      connection: Option<Connection>,
                      problem: Option<&str>| Client {
            id: id.into(),
            label: label.into(),
            config_path: path.into(),
            enabled,
            state,
            connection,
            problem: problem.map(str::to_string),
        };
        let clients = vec![
            client("claude-code", "Claude Code", "~/.claude.json", true, ClientState::Configured, Some(code.clone()), None),
            client(
                "claude-desktop",
                "Claude Desktop",
                "~/Library/Application Support/Claude/claude_desktop_config.json",
                false,
                ClientState::Off,
                None,
                None,
            ),
            client("cursor", "Cursor", "~/.cursor/mcp.json", false, ClientState::Off, None, None),
            client("codex", "Codex", "~/.codex/config.toml", false, ClientState::Off, None, None),
            client("zed", "Zed", "~/.config/zed/settings.json", false, ClientState::Unavailable, None, None),
        ];
        Self { clients, connections: vec![code, notes, old, revoked], projects, designs_on: true, next: 1 }
    }

    fn credential(&mut self, connection: Connection) -> Credential {
        self.next += 1;
        Credential {
            connection,
            url: "http://127.0.0.1:8777/mcp".into(),
            token: format!("mlgmcp_{:08x}{:08x}", 0x5eed_u32 ^ self.next, 0x9a1b_c2d3_u32.wrapping_mul(self.next)),
        }
    }

    pub fn create(&mut self, config: Configuration) -> Credential {
        self.next += 1;
        let connection = Connection { id: format!("conn-{}", self.next), config, revision: 1, revoked_at: None, client_id: None };
        self.connections.push(connection.clone());
        self.credential(connection)
    }

    pub fn update(&mut self, id: &str, config: Configuration) {
        if let Some(connection) = self.connections.iter_mut().find(|connection| connection.id == id) {
            connection.config = config;
            connection.revision += 1;
        }
    }

    pub fn rotate(&mut self, id: &str) -> Option<Credential> {
        let connection = self.connections.iter_mut().find(|connection| connection.id == id)?;
        connection.revision += 1;
        let connection = connection.clone();
        Some(self.credential(connection))
    }

    pub fn revoke(&mut self, id: &str) {
        if let Some(connection) = self.connections.iter_mut().find(|connection| connection.id == id) {
            connection.revoked_at = Some(NOW.to_string());
        }
    }

    pub fn enable_client(&mut self, id: &str, config: Configuration) {
        self.next += 1;
        let connection_id = format!("conn-{}", self.next);
        let Some(client) = self.clients.iter_mut().find(|client| client.id == id) else { return };
        let connection = Connection { id: connection_id, config, revision: 1, revoked_at: None, client_id: Some(id.to_string()) };
        client.enabled = true;
        client.state = ClientState::Configured;
        client.problem = None;
        client.connection = Some(connection.clone());
        self.connections.retain(|existing| existing.client_id.as_deref() != Some(id));
        self.connections.push(connection);
    }

    pub fn disable_client(&mut self, id: &str) {
        if let Some(client) = self.clients.iter_mut().find(|client| client.id == id) {
            client.enabled = false;
            client.state = ClientState::Off;
            client.connection = None;
        }
        self.connections.retain(|connection| connection.client_id.as_deref() != Some(id));
    }
}

pub struct LocalMcpView {
    pub(crate) host: LocalHost,
    busy: bool,
    error: String,
    setup: Option<String>,
    draft: Draft,
    credential: Option<Credential>,
    copied: bool,
    copy_error: bool,
    custom_open: bool,
    manage_open: bool,
    inputs: Option<Inputs>,
    found: Option<String>,
}

/// The three text fields of the setup form, created the first time the form is needed.
struct Inputs {
    label: Entity<InputState>,
    chat_id: Entity<InputState>,
    design_ids: Entity<InputState>,
    _subs: Vec<Subscription>,
}

fn projects_of(cx: &App) -> Vec<(String, String)> {
    use crate::data::{Data, LOCAL, Polled, poll_once};
    let Some(source) = cx.try_global::<Data>().map(|data| data.0.clone()) else { return Vec::new() };
    match poll_once(source.recent_projects(LOCAL.into())) {
        Polled::Ready(Ok(list)) => {
            list.into_iter().filter(|p| !p.hidden && !p.is_chats_home()).map(|p| (p.path.to_string(), p.name.to_string())).collect()
        }
        _ => Vec::new(),
    }
}

impl LocalMcpView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            host: LocalHost::fixture(projects_of(cx)),
            busy: false,
            error: String::new(),
            setup: None,
            draft: Draft::default(),
            credential: None,
            copied: false,
            copy_error: false,
            custom_open: false,
            manage_open: false,
            inputs: None,
            found: None,
        }
    }

    fn ensure_inputs(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Entity<InputState>, Entity<InputState>, Entity<InputState>) {
        if let Some(inputs) = &self.inputs {
            return (inputs.label.clone(), inputs.chat_id.clone(), inputs.design_ids.clone());
        }
        let label = Input::state("", window, cx);
        let chat_id = Input::state("/path/to/project#123", window, cx);
        let design_ids = Input::state("", window, cx);
        let subs = vec![
            cx.subscribe(&label, |this, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.draft.label = input.read(cx).value().to_string();
                    cx.notify();
                }
            }),
            cx.subscribe(&chat_id, |this, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.draft.chat_id = input.read(cx).value().to_string();
                    cx.notify();
                }
            }),
            cx.subscribe(&design_ids, |this, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.draft.design_ids = input.read(cx).value().to_string();
                    cx.notify();
                }
            }),
        ];
        self.inputs = Some(Inputs { label: label.clone(), chat_id: chat_id.clone(), design_ids: design_ids.clone(), _subs: subs });
        (label, chat_id, design_ids)
    }

    pub fn set_found(&mut self, row: Option<&str>, cx: &mut Context<Self>) {
        if self.found.as_deref() != row {
            self.found = row.map(str::to_string);
            cx.notify();
        }
    }

    pub fn setup(&self) -> Option<&str> {
        self.setup.as_deref()
    }

    pub fn draft(&self) -> &Draft {
        &self.draft
    }

    pub fn credential(&self) -> Option<&Credential> {
        self.credential.as_ref()
    }

    pub fn custom_open(&self) -> bool {
        self.custom_open
    }

    pub fn copied(&self) -> bool {
        self.copied
    }

    pub fn label_input(&self) -> Option<Entity<InputState>> {
        self.inputs.as_ref().map(|inputs| inputs.label.clone())
    }

    pub fn chat_input(&self) -> Option<Entity<InputState>> {
        self.inputs.as_ref().map(|inputs| inputs.chat_id.clone())
    }

    pub fn design_ids_input(&self) -> Option<Entity<InputState>> {
        self.inputs.as_ref().map(|inputs| inputs.design_ids.clone())
    }

    pub fn busy(&self) -> bool {
        self.busy
    }

    /// Runs `work` against the host after the command's round trip.
    fn run(&mut self, cx: &mut Context<Self>, work: impl FnOnce(&mut Self, &mut Context<Self>) + 'static) {
        self.busy = true;
        self.error.clear();
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(BUSY_MS)).await;
            this.update(cx, |this, cx| {
                this.busy = false;
                work(this, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn dismiss(&mut self) {
        self.credential = None;
        self.copied = false;
        self.copy_error = false;
    }

    /// Opens the setup form for a client, or the custom connection form when `client` is `None`.
    pub fn open_setup(&mut self, client: Option<&Client>, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss();
        self.setup = Some(client.map_or_else(|| "custom".to_string(), |client| client.id.clone()));
        self.draft = match client.and_then(|client| client.connection.as_ref()) {
            Some(connection) => Draft::for_configuration(&connection.config),
            None => Draft { label: client.map(|client| client.label.clone()).unwrap_or_default(), ..Draft::default() },
        };
        let draft = self.draft.clone();
        let (label, chat_id, design_ids) = self.ensure_inputs(window, cx);
        label.update(cx, |state, cx| state.set_value(draft.label.clone(), window, cx));
        chat_id.update(cx, |state, cx| state.set_value(draft.chat_id.clone(), window, cx));
        design_ids.update(cx, |state, cx| state.set_value(draft.design_ids.clone(), window, cx));
        cx.notify();
    }

    pub fn close_setup(&mut self, cx: &mut Context<Self>) {
        self.setup = None;
        cx.notify();
    }

    pub fn submit(&mut self, client_id: Option<String>, cx: &mut Context<Self>) {
        let mut config = self.draft.configuration();
        let client = client_id.as_ref().and_then(|id| self.host.clients.iter().find(|client| &client.id == id)).cloned();
        if let Some(expires) = client.as_ref().and_then(|client| client.connection.as_ref()).and_then(|c| c.config.expires_at.clone()) {
            config.expires_at = Some(expires);
        }
        if !self.draft.valid() {
            return;
        }
        self.run(cx, move |this, _| {
            match client_id {
                Some(id) => this.host.enable_client(&id, config),
                None => this.credential = Some(this.host.create(config)),
            }
            this.setup = None;
        });
    }

    pub fn toggle_client(&mut self, client: &Client, window: &mut Window, cx: &mut Context<Self>) {
        if client.enabled {
            self.setup = None;
            let id = client.id.clone();
            self.run(cx, move |this, _| this.host.disable_client(&id));
        } else if self.setup.as_deref() == Some(client.id.as_str()) {
            self.setup = None;
            cx.notify();
        } else {
            self.open_setup(Some(client), window, cx);
        }
    }

    pub fn toggle_custom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.custom_open {
            self.custom_open = false;
            if self.setup.as_deref() == Some("custom") {
                self.setup = None;
            }
            self.dismiss();
        } else {
            self.custom_open = true;
            let has_custom = self.host.connections.iter().any(|connection| connection.client_id.is_none());
            if !has_custom {
                self.open_setup(None, window, cx);
            }
        }
        cx.notify();
    }

    pub fn copy_config(&mut self, cx: &mut Context<Self>) {
        if let Some(credential) = &self.credential {
            cx.write_to_clipboard(ClipboardItem::new_string(client_config(credential)));
            self.copied = true;
            self.copy_error = false;
            cx.notify();
        }
    }

    pub fn replace_credential(&mut self, id: &str, cx: &mut Context<Self>) {
        self.copied = false;
        self.copy_error = false;
        let id = id.to_string();
        self.run(cx, move |this, _| this.credential = this.host.rotate(&id));
    }

    pub fn restrict(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(connection) = self.host.connections.iter().find(|connection| connection.id == id).cloned() else { return };
        let id = id.to_string();
        self.run(cx, move |this, _| this.host.update(&id, read_only(&connection)));
    }

    pub fn revoke(&mut self, id: &str, cx: &mut Context<Self>) {
        let id = id.to_string();
        self.run(cx, move |this, _| this.host.revoke(&id));
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.run(cx, |_, _| {});
    }
}

fn divider(theme: &Theme) -> AnyElement {
    div().w_full().h(px(1.0)).bg(theme.line).into_any_element()
}

impl LocalMcpView {
    fn scope_fields(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let inputs = self.inputs.as_ref().expect("created by render");
        let draft = &self.draft;
        let kinds = RadioGroup::new(
            "local-mcp-kind",
            Some(draft.kind.id()),
            DraftKind::ALL.into_iter().map(|kind| RadioOption::new(kind.id(), kind.label())),
        )
        .horizontal()
        .on_change(cx.listener(|this, value: &SharedString, _, cx| {
            if let Some(kind) = DraftKind::from_id(value) {
                this.draft.set_kind(kind);
                cx.notify();
            }
        }));
        let detail: AnyElement = match draft.kind {
            DraftKind::Projects => {
                let projects = &self.host.projects;
                div()
                    .id("local-mcp-projects")
                    .max_h(px(176.0))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .when(projects.is_empty(), |d| {
                        d.child(div().text_step(TEXT_12).text_color(theme.ink2).child("Open a Project in Milagre to grant access to it."))
                    })
                    .children(projects.iter().map(|(path, name)| {
                        let toggle_path = path.clone();
                        div()
                            .flex()
                            .items_start()
                            .gap(px(8.0))
                            .child(
                                Checkbox::new(
                                    SharedString::from(format!("local-mcp-project-{}", slug(name))),
                                    draft.project_paths.contains(path),
                                )
                                .on_toggle(
                                    cx.listener(move |this, _: &bool, _, cx| {
                                        this.draft.toggle_project(&toggle_path);
                                        cx.notify();
                                    })
                                    .adapt(),
                                ),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .child(div().text_step(TEXT_13).text_color(theme.ink).child(name.clone()))
                                    .child(div().text_step(TEXT_12).text_color(theme.ink2).child(path.clone())),
                            )
                    }))
                    .into_any_element()
            }
            DraftKind::AllProjects => div()
                .text_step(TEXT_12)
                .text_color(theme.ink2)
                .child("Includes every Project open in Milagre now and any Project added later.")
                .into_any_element(),
            DraftKind::Designs => div()
                .flex()
                .flex_col()
                .gap(px(16.0))
                .child(labelled("Chat reference", &theme, Input::new("local-mcp-chat", &inputs.chat_id)))
                .child(labelled("Design IDs", &theme, Input::new("local-mcp-designs", &inputs.design_ids)))
                .child(
                    div()
                        .text_step(TEXT_12)
                        .text_color(theme.ink2)
                        .child("Use * for all designs in this Chat, or separate IDs with commas. Public sharing is separate."),
                )
                .when(!self.host.designs_on, |d| {
                    d.child(div().text_step(TEXT_12).text_color(theme.ink2).child("Design tools are unavailable while Designs is off."))
                })
                .into_any_element(),
        };
        let write_label =
            if draft.kind == DraftKind::Designs { "Allow design edits" } else { "Allow creating Worktrees and Chats and starting tasks" };
        div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(div().flex().flex_col().gap(px(8.0)).child(field_label("Allow access to", &theme)).child(kinds))
            .child(detail)
            .child(
                Checkbox::new("local-mcp-write", draft.write).label(write_label).on_toggle(
                    cx.listener(|this, on: &bool, _, cx| {
                        this.draft.write = *on;
                        cx.notify();
                    })
                    .adapt(),
                ),
            )
            .into_any_element()
    }

    fn editor(&self, client: Option<&Client>, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let inputs = self.inputs.as_ref().expect("created by render");
        let title = match client {
            Some(client) => format!("Access for {}", client.label),
            None => "Custom connection".to_string(),
        };
        let submit_label = if self.busy {
            "Saving…".to_string()
        } else {
            match client {
                Some(client) if client.enabled => "Save access".to_string(),
                Some(client) => format!("Enable {}", client.label),
                None => "Create configuration".to_string(),
            }
        };
        let client_id = client.map(|client| client.id.clone());
        div()
            .debug_selector(|| "local-mcp-setup".into())
            .flex()
            .flex_col()
            .gap(px(16.0))
            .bg(theme.hover)
            .px(px(16.0))
            .py(px(20.0))
            .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(title))
            .when(client.is_none(), |d| d.child(labelled("Connection name", &theme, Input::new("local-mcp-label", &inputs.label))))
            .child(self.scope_fields(cx))
            .child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        Button::new("local-mcp-submit", submit_label)
                            .disabled(self.busy || !self.draft.valid())
                            .on_click(cx.listener(move |this, _, _, cx| this.submit(client_id.clone(), cx))),
                    )
                    .child(
                        Button::new("local-mcp-cancel", "Cancel")
                            .variant(ButtonVariant::Secondary)
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.close_setup(cx))),
                    ),
            )
            .into_any_element()
    }

    fn client_row(&self, client: &Client, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let detail = client_detail(client);
        let expanded = self.setup.as_deref() == Some(client.id.as_str());
        let row_client = client.clone();
        let set_up_client = client.clone();
        let id = slug(&client.id);
        let row = div()
            .debug_selector({
                let id = id.clone();
                move || format!("local-client-{id}")
            })
            .min_h(px(56.0))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(16.0))
            .py(px(12.0))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(client.label.clone()))
                    .when(!detail.is_empty(), |d| {
                        d.child(
                            div()
                                .text_step(TEXT_12)
                                .text_color(if client.problem.is_some() { theme.red_ink } else { theme.ink2 })
                                .child(detail),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(12.0))
                    .when(client.enabled || client.state == ClientState::Error, |d| {
                        d.child(
                            Button::new(SharedString::from(format!("local-setup-{id}")), "Set up")
                                .variant(ButtonVariant::Quiet)
                                .size(ButtonSize::S24)
                                .disabled(self.busy)
                                .on_click(cx.listener(move |this, _, window, cx| this.open_setup(Some(&set_up_client), window, cx))),
                        )
                    })
                    .child(
                        Checkbox::new(SharedString::from(format!("local-enable-{id}")), client.enabled)
                            .disabled(self.busy || client.state == ClientState::Unavailable)
                            .on_toggle(cx.listener(move |this, _: &bool, window, cx| this.toggle_client(&row_client, window, cx)).adapt()),
                    ),
            );
        div().flex().flex_col().child(row).when(expanded, |d| d.child(self.editor(Some(client), cx))).into_any_element()
    }

    fn credential_card(&self, credential: &Credential, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let _ = credential;
        div()
            .debug_selector(|| "local-mcp-credential".into())
            .flex()
            .flex_col()
            .gap(px(12.0))
            .py(px(8.0))
            .child(
                div()
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child("Copy this configuration now. The credential is available only once."),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        Button::new("local-mcp-copy", if self.copied { "Copied" } else { "Copy MCP config" })
                            .variant(ButtonVariant::Secondary)
                            .on_click(cx.listener(|this, _, _, cx| this.copy_config(cx))),
                    )
                    .child(Button::new("local-mcp-done", "Done").variant(ButtonVariant::Secondary).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.dismiss();
                            cx.notify();
                        },
                    ))),
            )
            .child(
                InlineError::new(if self.copy_error { "Could not copy. Try again before closing this configuration." } else { "" }).small(),
            )
            .into_any_element()
    }

    fn connections(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let custom: Vec<&Connection> = self.host.connections.iter().filter(|connection| connection.client_id.is_none()).collect();
        let head = div()
            .id("local-mcp-manage")
            .debug_selector(|| "local-mcp-manage".into())
            .py(px(8.0))
            .cursor_pointer()
            .text_step(TEXT_12)
            .text_color(theme.ink2)
            .on_click(cx.listener(|this, _, _, cx| {
                this.manage_open = !this.manage_open;
                cx.notify();
            }))
            .child(format!("{} Manage custom connections ({})", if self.manage_open { "▾" } else { "▸" }, custom.len()));
        let rows = custom.iter().map(|connection| {
            let active = connection.active(NOW);
            let id = connection.id.clone();
            let suffix = if connection.revoked_at.is_some() {
                " (Revoked)"
            } else if !active {
                " (Expired)"
            } else {
                ""
            };
            let slug_id = slug(&connection.id);
            let (rotate_id, restrict_id, revoke_id) = (id.clone(), id.clone(), id);
            div()
                .debug_selector(move || format!("local-connection-{slug_id}"))
                .flex()
                .flex_col()
                .gap(px(8.0))
                .py(px(12.0))
                .child(div().text_step(TEXT_13).text_color(theme.ink).child(format!("{}{suffix}", connection.config.label)))
                .child(div().text_step(TEXT_12).text_color(theme.ink2).child(description(connection)))
                .when(active, |d| {
                    d.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(8.0))
                            .child(
                                Button::new(SharedString::from(format!("local-rotate-{}", slug(&rotate_id))), "Replace credential")
                                    .variant(ButtonVariant::Secondary)
                                    .disabled(self.busy)
                                    .on_click(cx.listener(move |this, _, _, cx| this.replace_credential(&rotate_id, cx))),
                            )
                            .when(connection.writable(), |d| {
                                d.child(
                                    Button::new(SharedString::from(format!("local-restrict-{}", slug(&restrict_id))), "Restrict to read")
                                        .variant(ButtonVariant::Secondary)
                                        .disabled(self.busy)
                                        .on_click(cx.listener(move |this, _, _, cx| this.restrict(&restrict_id, cx))),
                                )
                            })
                            .child(
                                Button::new(SharedString::from(format!("local-revoke-{}", slug(&revoke_id))), "Revoke")
                                    .variant(ButtonVariant::DangerGhost)
                                    .disabled(self.busy)
                                    .on_click(cx.listener(move |this, _, _, cx| this.revoke(&revoke_id, cx))),
                            ),
                    )
                })
                .into_any_element()
        });
        let mut list = div().flex().flex_col();
        for (ix, row) in rows.enumerate() {
            if ix > 0 {
                list = list.child(divider(&theme));
            }
            list = list.child(row);
        }
        div()
            .flex()
            .flex_col()
            .child(head)
            .when(self.manage_open, |d| d.child(div().id("local-mcp-connections").max_h(px(256.0)).overflow_y_scroll().child(list)))
            .into_any_element()
    }
}

fn field_label(text: &'static str, theme: &Theme) -> gpui::Div {
    div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(text)
}

fn labelled(text: &'static str, theme: &Theme, field: impl IntoElement) -> AnyElement {
    div().flex().flex_col().gap(px(4.0)).child(field_label(text, theme)).child(field).into_any_element()
}

impl Render for LocalMcpView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_inputs(window, cx);
        let theme = *cx.theme();
        let clients = self.host.clients.clone();
        let mut client_list = div().flex().flex_col().when(self.busy, |d| d.opacity(0.9));
        for (ix, client) in clients.iter().enumerate() {
            if ix > 0 {
                client_list = client_list.child(divider(&theme));
            }
            client_list = client_list.child(self.client_row(client, cx));
        }
        let custom_found = self.found.as_deref() == Some("Custom MCP");
        let create_found = self.found.as_deref() == Some("Create MCP config");
        let credential = self.credential.clone();
        let custom_body = div()
            .id("custom-mcp-settings")
            .debug_selector(|| "custom-mcp-settings".into())
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(
                div()
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child("For another app, create a scoped connection and copy its configuration."),
            )
            .when(self.setup.as_deref() != Some("custom") && credential.is_none(), |d| {
                d.child(
                    div().when(create_found, |d| d.bg(theme.hover2)).child(
                        Button::new("local-mcp-create", "Create MCP config")
                            .variant(ButtonVariant::Secondary)
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.open_setup(None, window, cx))),
                    ),
                )
            })
            .when(self.setup.as_deref() == Some("custom"), |d| d.child(self.editor(None, cx)))
            .when_some(credential.as_ref(), |d, credential| d.child(self.credential_card(credential, cx)))
            .when(self.host.connections.iter().any(|connection| connection.client_id.is_none()), |d| d.child(self.connections(cx)));
        div()
            .debug_selector(|| "local-mcp".into())
            .mt(px(20.0))
            .flex()
            .flex_col()
            .gap(px(24.0))
            .child(
                div()
                    .max_w(px(560.0))
                    .text_step(TEXT_13)
                    .text_color(theme.ink2)
                    .child("Connect your local tools to Milagre. Choose which Projects or Designs each app can access when you enable it."),
            )
            .child(InlineError::new(self.error.clone()))
            .child(client_list)
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(px(16.0))
                    .child(
                        div().max_w(px(560.0)).text_step(TEXT_12).text_color(theme.ink2).child(
                            "Enabled clients are set up when Milagre starts. Restart a client after enabling it; scope changes apply at once. Access stays on the computer running Milagre.",
                        ),
                    )
                    .child(
                        Button::new("local-mcp-refresh", "Refresh")
                            .variant(ButtonVariant::Quiet)
                            .size(ButtonSize::S24)
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .border_t_1()
                    .border_color(theme.line)
                    .pt(px(24.0))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_between()
                            .gap(px(12.0))
                            .child(
                                div()
                                    .rounded(crate::theme::RADIUS_CONTROL)
                                    .when(custom_found, |d| d.bg(theme.hover2))
                                    .text_step(TEXT_13)
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.ink)
                                    .child("Custom MCP"),
                            )
                            .child(
                                Checkbox::new("local-mcp-custom", self.custom_open)
                                    .disabled(self.busy)
                                    .on_toggle(cx.listener(|this, _: &bool, window, cx| this.toggle_custom(window, cx)).adapt()),
                            ),
                    )
                    .when(self.custom_open, |d| d.child(custom_body)),
            )
    }
}
