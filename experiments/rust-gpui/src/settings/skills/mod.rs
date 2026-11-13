//! Settings › Skills (WP-43: `SkillsSettings.tsx`, `shared/skill-catalog.ts`; G-13): every skill the `/` menu
//! offers for the open Project, where each comes from, which same-named ones it hides and what discovery could
//! not read; a skill opens to its SKILL.md. Read from the fixture on open and on Reload, or, with a data layer's
//! [`SettingsHost`](crate::settings::host::SettingsHost), from the host: `skills:list [projectPath]` when the page shows a
//! Project and on Reload, `skills:read [projectPath, file]` for the open skill. Open in editor and Show in Finder go to
//! the window ([`host::OPEN_FILE`], [`host::REVEAL`]) for a file the list holds, as Electron's main checks it.
//!
//! Without a host, Open in editor and Show in Finder only record the request; the list is a plain column inside the
//! Settings body's scroll area.

pub mod model;

#[cfg(test)]
mod tests;

use std::time::Duration;

use gpui::{
    AnyElement, App, ClipboardItem, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription,
    Window, div, prelude::*, px,
};
use gpui_base::TextViewState;
use gpui_component::input::{InputEvent, InputState};

use self::model::{
    PROVIDERS, Scope, Shadowed, Skill, catalog, filter_skills, fixture, group_skills, overrides_text, provider_label, read_skill,
    shadowed_by, shorten_home, skill_body,
};
use crate::settings::group::{page_header, slug};
use crate::settings::host;
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TextStepExt, Theme};
use crate::ui::markdown::{Markdown, base_extensions, open_with_system, text_view_style};
use crate::ui::{Button, ButtonSize, ButtonVariant, EmptyState, FieldSize, Input, SectionLabel, Select, SelectOption};

/// How long the fixture's discovery and file read take.
pub const READ_MS: u64 = 120;
/// How long "Copied" stays on the button.
pub const COPIED_MS: u64 = 1500;
/// The editor the fixture finds installed.
pub const EDITOR: &str = "Cursor";

enum Content {
    Reading,
    Text(Entity<TextViewState>),
    Error(String),
}

pub struct SkillsView {
    project: Option<(String, String)>,
    skills: Vec<Skill>,
    shadowed: Vec<Shadowed>,
    warnings: Vec<String>,
    loading: bool,
    revision: u64,
    query: Option<Entity<InputState>>,
    _query_sub: Option<Subscription>,
    scope: Option<Scope>,
    provider: Option<String>,
    selected: Option<usize>,
    content: Content,
    copied: bool,
    copy_run: u64,
    pub(crate) last_action: Option<String>,
    found: Option<String>,
    /// With a host: the editor Open in editor uses (`None`: none installed), and why an action failed.
    editor: Option<String>,
    action_error: Option<String>,
    seen_visit: Option<u64>,
}

impl SkillsView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        // A host lists the open Project's skills when the page shows it; the fixture's are there from the start.
        let (skills, shadowed, warnings) = if host::host(cx).is_some() { Default::default() } else { fixture() };
        Self {
            project: None,
            skills,
            shadowed,
            warnings,
            loading: false,
            revision: 0,
            query: None,
            _query_sub: None,
            scope: None,
            provider: None,
            selected: None,
            content: Content::Reading,
            copied: false,
            copy_run: 0,
            last_action: None,
            found: None,
            editor: Some(EDITOR.to_string()),
            action_error: None,
            seen_visit: None,
        }
    }

    /// The Project the page lists skills for; `None` when no Project is open. A host lists the new Project's skills.
    pub fn set_project(&mut self, project: Option<(String, String)>, cx: &mut Context<Self>) {
        if self.project != project {
            self.project = project;
            self.selected = None;
            if host::host(cx).is_some() {
                self.skills.clear();
                self.shadowed.clear();
                self.warnings.clear();
                self.reload(cx);
            }
            cx.notify();
        }
    }

    /// Lists the skills again when Settings opened or came to this page since the last list (a host only).
    pub fn visit(&mut self, cx: &mut Context<Self>) {
        let Some(visit) = host::visit(cx) else { return };
        if self.seen_visit != Some(visit) {
            let first = self.seen_visit.is_none();
            self.seen_visit = Some(visit);
            // `set_project` already listed a Project it just took.
            if !first || !self.loading {
                self.reload(cx);
            }
        }
    }

    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    pub fn action_error(&self) -> Option<&str> {
        self.action_error.as_deref()
    }

    pub fn set_found(&mut self, row: Option<&str>, cx: &mut Context<Self>) {
        if self.found.as_deref() != row {
            self.found = row.map(str::to_string);
            cx.notify();
        }
    }

    pub fn skills(&self) -> &[Skill] {
        &self.skills
    }

    pub fn selected(&self) -> Option<&Skill> {
        self.selected.and_then(|ix| self.skills.get(ix))
    }

    pub fn loading(&self) -> bool {
        self.loading
    }

    pub fn copied(&self) -> bool {
        self.copied
    }

    pub fn query_input(&self) -> Option<Entity<InputState>> {
        self.query.clone()
    }

    pub fn filter(&self) -> (Option<Scope>, Option<String>) {
        (self.scope, self.provider.clone())
    }

    pub fn reading(&self) -> bool {
        matches!(self.content, Content::Reading)
    }

    pub fn read_error(&self) -> Option<&str> {
        match &self.content {
            Content::Error(message) => Some(message),
            _ => None,
        }
    }

    fn ensure_query(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(query) = &self.query {
            return query.clone();
        }
        let query = Input::state("Search skills", window, cx);
        self._query_sub = Some(cx.subscribe(&query, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        }));
        self.query = Some(query.clone());
        query
    }

    /// Reload: discovery reads the folders again.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.revision += 1;
        let revision = self.revision;
        cx.notify();
        if host::host(cx).is_some() {
            self.list_from_host(revision, cx);
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(READ_MS)).await;
            this.update(cx, |this, cx| {
                if this.revision != revision {
                    return;
                }
                this.loading = false;
                if this.selected.is_some() {
                    this.read_selected(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// `skills:list` on the host; a failure shows as the page's one warning, as `useSkills` does.
    fn list_from_host(&mut self, revision: u64, cx: &mut Context<Self>) {
        let Some((path, _)) = self.project.clone() else {
            self.loading = false;
            return;
        };
        if let Some(task) = host::call("skills:list", serde_json::json!([path]), cx) {
            cx.spawn(async move |this, cx| {
                let answer = task.await;
                this.update(cx, |this, cx| {
                    if this.revision != revision {
                        return;
                    }
                    this.loading = false;
                    let selected = this.selected().map(|s| s.path.clone());
                    match answer {
                        Ok(value) => (this.skills, this.shadowed, this.warnings) = catalog(&value),
                        Err(message) => {
                            this.skills.clear();
                            this.shadowed.clear();
                            this.warnings = vec![message];
                        }
                    }
                    // The open skill stays open while the list still has it, and is read again.
                    this.selected = selected.and_then(|path| this.skills.iter().position(|s| s.path == path));
                    if this.selected.is_some() {
                        this.read_selected(cx);
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        if let Some(task) = host::call(host::EDITOR, serde_json::json!([]), cx) {
            cx.spawn(async move |this, cx| {
                let editor = task.await.ok().and_then(|value| value.as_str().map(str::to_string));
                this.update(cx, |this, cx| {
                    this.editor = editor;
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
    }

    /// Open in editor or Show in Finder for the open skill, through the host (`skills:open`, `skills:reveal`).
    pub fn file_action(&mut self, method: &'static str, cx: &mut Context<Self>) {
        let Some(skill) = self.selected().cloned() else { return };
        self.last_action = Some(format!("{}:{}", if method == host::REVEAL { "reveal" } else { "open" }, skill.path));
        self.action_error = None;
        cx.notify();
        // Only a file the Project's catalog lists, as Electron's main checks (`checkSkillFile`).
        let listed = self.skills.iter().map(|s| &s.path).chain(self.shadowed.iter().map(|s| &s.path)).any(|p| *p == skill.path);
        if !listed {
            self.action_error = Some("That skill is no longer there. Reload the list.".into());
            return;
        }
        let Some(task) = host::call(method, serde_json::json!([skill.path]), cx) else { return };
        cx.spawn(async move |this, cx| {
            if let Err(message) = task.await {
                this.update(cx, |this, cx| {
                    this.action_error = Some(message);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    pub fn open(&mut self, index: usize, cx: &mut Context<Self>) {
        self.selected = Some(index);
        self.copied = false;
        self.read_selected(cx);
        cx.notify();
    }

    pub fn back(&mut self, cx: &mut Context<Self>) {
        self.selected = None;
        cx.notify();
    }

    fn read_selected(&mut self, cx: &mut Context<Self>) {
        let Some(skill) = self.selected().cloned() else { return };
        self.content = Content::Reading;
        self.action_error = None;
        let revision = self.revision;
        if let Some((project, _)) = self.project.clone().filter(|_| host::host(cx).is_some()) {
            let Some(task) = host::call("skills:read", serde_json::json!([project, skill.path]), cx) else { return };
            cx.spawn(async move |this, cx| {
                let answer = task.await;
                this.update(cx, |this, cx| {
                    if this.selected().map(|s| &s.path) != Some(&skill.path) || this.revision != revision {
                        return;
                    }
                    this.content = match answer {
                        Ok(value) => {
                            let body = skill_body(value.as_str().unwrap_or_default());
                            Content::Text(cx.new(|cx| TextViewState::markdown(&body, cx)))
                        }
                        Err(message) => Content::Error(message),
                    };
                    cx.notify();
                })
                .ok();
            })
            .detach();
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(READ_MS)).await;
            this.update(cx, |this, cx| {
                if this.selected().map(|s| (&s.name, &s.path)) != Some((&skill.name, &skill.path)) || this.revision != revision {
                    return;
                }
                this.content = match read_skill(&skill) {
                    Ok(text) => {
                        let body = skill_body(&text);
                        Content::Text(cx.new(|cx| TextViewState::markdown(&body, cx)))
                    }
                    Err(message) => Content::Error(message),
                };
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn copy_command(&mut self, cx: &mut Context<Self>) {
        let Some(skill) = self.selected() else { return };
        cx.write_to_clipboard(ClipboardItem::new_string(format!("/{}", skill.name)));
        self.copied = true;
        self.copy_run += 1;
        let run = self.copy_run;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(COPIED_MS)).await;
            this.update(cx, |this, cx| {
                if this.copy_run == run {
                    this.copied = false;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn badge(text: String, theme: &Theme) -> AnyElement {
        div()
            .flex_none()
            .rounded_full()
            .bg(theme.field)
            .px(px(8.0))
            .py(px(1.0))
            .text_step(TEXT_11)
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.ink2)
            .child(text)
            .into_any_element()
    }
}

fn card(theme: &Theme, rows: Vec<AnyElement>) -> AnyElement {
    let mut card = div().rounded(RADIUS_CARD).border_1().border_color(theme.line).bg(theme.surface).overflow_hidden().flex().flex_col();
    for (ix, row) in rows.into_iter().enumerate() {
        if ix > 0 {
            card = card.child(div().w_full().h(px(1.0)).bg(theme.line));
        }
        card = card.child(row);
    }
    card.into_any_element()
}

impl SkillsView {
    fn list(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let query = self.ensure_query(window, cx);
        let text = query.read(cx).value().to_string();
        let visible = filter_skills(&self.skills, &text, self.scope, self.provider.as_deref());
        let groups = group_skills(&visible);
        let page = cx.entity();

        let scope_select = {
            let page = page.clone();
            Select::new(
                "skills-scope",
                self.scope.map_or("all", Scope::id),
                std::iter::once(SelectOption::new("all", "All scopes"))
                    .chain(Scope::ALL.into_iter().map(|s| SelectOption::new(s.id(), s.label()))),
            )
            .width(160.0)
            .on_change(move |value, _, cx| {
                let scope = Scope::from_id(value);
                page.update(cx, |this, cx| {
                    this.scope = scope;
                    cx.notify();
                })
            })
        };
        let provider_select = {
            let page = page.clone();
            Select::new(
                "skills-source",
                self.provider.clone().unwrap_or_else(|| "all".to_string()),
                std::iter::once(SelectOption::new("all", "All sources"))
                    .chain(PROVIDERS.iter().map(|(id, label)| SelectOption::new(*id, *label))),
            )
            .width(160.0)
            .on_change(move |value, _, cx| {
                let provider = (value.as_ref() != "all").then(|| value.to_string());
                page.update(cx, |this, cx| {
                    this.provider = provider;
                    cx.notify();
                })
            })
        };

        let mut col = div()
            .flex()
            .flex_col()
            .gap(px(20.0))
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(px(24.0))
                    .child(
                        div().max_w(px(430.0)).text_step(TEXT_13).text_color(theme.ink3).child(
                            "Skills from this Project and your home folder. When two share a name, the first one found wins and the / menu offers only that one.",
                        ),
                    )
                    .child(
                        Button::new("skills-reload", if self.loading { "Reloading…" } else { "Reload" })
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S28)
                            .disabled(self.loading)
                            .on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().min_w_0().flex_1().child(Input::new("skills-search", &query).size(FieldSize::S36)))
                    .child(scope_select)
                    .child(provider_select),
            );
        for (scope, skills) in &groups {
            let rows = skills.iter().map(|skill| self.row(skill, cx)).collect();
            col = col.child(
                div()
                    .debug_selector({
                        let id = scope.id();
                        move || format!("skill-group-{id}")
                    })
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(div().px(px(4.0)).child(SectionLabel::new(format!("{} · {}", scope.label(), skills.len()))))
                    .child(card(&theme, rows)),
            );
        }
        if groups.is_empty() && !self.loading {
            col = col.child(EmptyState::new().title("No skills found. Create one in .claude/skills/<name>/SKILL.md."));
        }
        if !self.warnings.is_empty() {
            let rows = self
                .warnings
                .iter()
                .map(|warning| {
                    div().px(px(16.0)).py(px(8.0)).text_step(TEXT_12).text_color(theme.ink2).child(shorten_home(warning)).into_any_element()
                })
                .collect();
            col = col.child(
                div()
                    .debug_selector(|| "skill-warnings".into())
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(div().px(px(4.0)).child(SectionLabel::new(format!("Warnings · {}", self.warnings.len()))))
                    .child(card(&theme, rows)),
            );
        }
        col.into_any_element()
    }

    fn row(&self, skill: &Skill, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let index = self.skills.iter().position(|s| s.name == skill.name && s.path == skill.path && s.scope == skill.scope).unwrap_or(0);
        let hidden = shadowed_by(&self.shadowed, skill).len();
        div()
            .id(SharedString::from(format!("skill-row-{}-{}", skill.scope.id(), slug(&skill.name))))
            .debug_selector({
                let id = format!("skill-row-{}-{}", skill.scope.id(), slug(&skill.name));
                move || id.clone()
            })
            .w_full()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .px(px(16.0))
            .py(px(8.0))
            .cursor_pointer()
            .hover(|s| s.bg(theme.hover))
            .active(|s| s.bg(theme.hover2))
            .on_click(cx.listener(move |this, _, _, cx| this.open(index, cx)))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .truncate()
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink)
                            .child(format!("/{}", skill.name)),
                    )
                    .child(Self::badge(provider_label(&skill.provider), &theme))
                    .when(hidden > 0, |d| {
                        d.child(div().flex_none().text_step(TEXT_11).text_color(theme.orange_ink).child(overrides_text(hidden)))
                    }),
            )
            .child(div().truncate().text_step(TEXT_12).text_color(theme.ink2).child(skill.description.clone()))
            .when(!skill.path.is_empty(), |d| {
                d.child(
                    div()
                        .truncate()
                        .font_family(crate::theme::mono())
                        .text_step(TEXT_11)
                        .text_color(theme.ink3)
                        .child(shorten_home(&skill.path)),
                )
            })
            .into_any_element()
    }

    fn detail(&self, skill: &Skill, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let hidden: Vec<&Shadowed> = shadowed_by(&self.shadowed, skill);
        // A paired computer's skill opens on that computer only (`isRemoteKey`).
        let has_file = !skill.path.is_empty();
        let local_file = has_file && !self.project.as_ref().is_some_and(|(path, _)| path.contains('|'));
        let hosted = host::host(cx).is_some();
        let page = cx.entity();
        let record = {
            let page = page.clone();
            move |what: String| {
                let page = page.clone();
                move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                    let what = what.clone();
                    page.update(cx, |this, cx| {
                        this.last_action = Some(what);
                        cx.notify();
                    })
                }
            }
        };
        let body: AnyElement = match &self.content {
            Content::Reading => div().text_color(theme.ink3).child("Reading SKILL.md…").into_any_element(),
            Content::Error(message) => {
                div().text_color(theme.red_ink).child(format!("Couldn't read this skill: {message}")).into_any_element()
            }
            Content::Text(state) => {
                Markdown::new(state, text_view_style(&theme, 13.0), base_extensions(), open_with_system()).size(13.0).into_any_element()
            }
        };
        let shadow_rows: Vec<AnyElement> = hidden
            .iter()
            .map(|item| {
                div()
                    .px(px(16.0))
                    .py(px(8.0))
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .text_step(TEXT_12)
                            .text_color(theme.ink2)
                            .child(Self::badge(provider_label(&item.provider), &theme))
                            .child(item.scope.label()),
                    )
                    .child(
                        div().font_family(crate::theme::mono()).text_step(TEXT_11).text_color(theme.ink3).child(shorten_home(&item.path)),
                    )
                    .into_any_element()
            })
            .collect();
        div()
            .debug_selector(|| "skill-detail".into())
            .flex()
            .flex_col()
            .gap(px(20.0))
            .child(
                div().child(
                    Button::new("skills-back", "All skills")
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S28)
                        .on_click(cx.listener(|this, _, _, cx| this.back(cx))),
                ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .rounded(RADIUS_CARD)
                    .border_1()
                    .border_color(theme.line)
                    .bg(theme.surface)
                    .p(px(16.0))
                    .child(
                        div()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .truncate()
                                    .text_step(TEXT_15)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.ink)
                                    .child(format!("/{}", skill.name)),
                            )
                            .child(Self::badge(provider_label(&skill.provider), &theme))
                            .child(Self::badge(skill.scope.label().to_string(), &theme)),
                    )
                    .child(div().text_step(TEXT_13).text_color(theme.ink2).child(skill.description.clone()))
                    .when(has_file, |d| {
                        d.child(
                            div()
                                .font_family(crate::theme::mono())
                                .text_step(TEXT_11)
                                .text_color(theme.ink3)
                                .child(shorten_home(&skill.path)),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(8.0))
                            .when(local_file && !hosted, |d| {
                                d.child(
                                    Button::new("skill-open", format!("Open in {EDITOR}"))
                                        .variant(ButtonVariant::Secondary)
                                        .size(ButtonSize::S28)
                                        .on_click(record(format!("open:{}", skill.path))),
                                )
                                .child(
                                    Button::new("skill-reveal", "Show in Finder")
                                        .variant(ButtonVariant::Secondary)
                                        .size(ButtonSize::S28)
                                        .on_click(record(format!("reveal:{}", skill.path))),
                                )
                            })
                            .when(local_file && hosted, |d| {
                                let open = match &self.editor {
                                    Some(editor) => Button::new("skill-open", format!("Open in {editor}"))
                                        .variant(ButtonVariant::Secondary)
                                        .size(ButtonSize::S28)
                                        .on_click(cx.listener(|this, _, _, cx| this.file_action(host::OPEN_FILE, cx))),
                                    None => Button::new("skill-open", "Open in editor")
                                        .variant(ButtonVariant::Secondary)
                                        .size(ButtonSize::S28)
                                        .disabled(true),
                                };
                                d.child(open).child(
                                    Button::new("skill-reveal", "Show in Finder")
                                        .variant(ButtonVariant::Secondary)
                                        .size(ButtonSize::S28)
                                        .on_click(cx.listener(|this, _, _, cx| this.file_action(host::REVEAL, cx))),
                                )
                            })
                            .child(
                                Button::new("skill-copy", if self.copied { "Copied".to_string() } else { format!("Copy /{}", skill.name) })
                                    .variant(ButtonVariant::Secondary)
                                    .size(ButtonSize::S28)
                                    .on_click(cx.listener(|this, _, _, cx| this.copy_command(cx))),
                            ),
                    ),
            )
            .when_some(self.action_error.clone(), |d, message| {
                d.child(div().debug_selector(|| "skill-action-error".into()).text_step(TEXT_12).text_color(theme.red_ink).child(message))
            })
            .when(!shadow_rows.is_empty(), |d| {
                d.child(
                    div()
                        .debug_selector(|| "skill-shadowed".into())
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(div().px(px(4.0)).child(SectionLabel::new(overrides_text(shadow_rows.len()))))
                        .child(card(&theme, shadow_rows)),
                )
            })
            .child(
                div()
                    .debug_selector(|| "skill-body".into())
                    .rounded(RADIUS_CARD)
                    .border_1()
                    .border_color(theme.line)
                    .bg(theme.surface)
                    .px(px(20.0))
                    .py(px(16.0))
                    .text_step(TEXT_13)
                    .text_color(theme.ink)
                    .child(body),
            )
            .into_any_element()
    }
}

impl Render for SkillsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let body: AnyElement = match (self.project.is_some(), self.selected().cloned()) {
            (false, _) => div().text_step(TEXT_13).text_color(theme.ink3).child("Open a project to see its skills.").into_any_element(),
            (true, Some(skill)) => self.detail(&skill, cx),
            (true, None) => self.list(window, cx),
        };
        div().debug_selector(|| "settings-section-skills".into()).flex().flex_col().child(page_header("Skills", None, cx)).child(body)
    }
}
