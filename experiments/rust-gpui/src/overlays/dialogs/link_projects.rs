//! Link Projects and Edit Link (O-08; `LinkProjectDialog.tsx`): creates a Link, or edits one's name and member
//! Projects. Chats already started keep their Worktrees. Editing, it offers "Delete Link…", which `on_delete` takes
//! to its confirmation. A member whose folder is gone is still listed, so it can be removed.

use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, FontWeight, IntoElement, Render, ScrollHandle, SharedString,
    Subscription, Task, Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

use super::copy::{LINK_CHAT_WORKTREES_TEXT, LINK_UPDATE_WORKTREES_TEXT};
use super::host::{LinkProject, NamedLink};
use super::{Host, STEP, call, field_label, footer};
use crate::logic::copy::model_copy::UI_COPY;
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Button, ButtonVariant, Checkbox, Dialog, EmptySize, EmptyState, InlineError, Input, ProjectAvatar, ScrollArea, Skeleton};

type Created = Rc<dyn Fn(&NamedLink, &mut App)>;
/// Takes "Delete Link…" to its confirmation.
pub type DeleteLink = Rc<dyn Fn(&NamedLink, &mut Window, &mut App)>;

/// The Link needs at least this many Projects.
pub const MIN_PROJECTS: usize = 2;

pub struct LinkProjectsDialog {
    host: Host,
    link: Option<NamedLink>,
    projects: Vec<LinkProject>,
    loading: bool,
    selected: Vec<String>,
    name: Entity<InputState>,
    search: Entity<InputState>,
    error: String,
    saving: bool,
    on_saved: Created,
    on_delete: Option<DeleteLink>,
    scroll: ScrollHandle,
    _subscriptions: Vec<Subscription>,
    _read: Option<Task<()>>,
    _save: Option<Task<()>>,
}

impl LinkProjectsDialog {
    fn new(
        link: Option<NamedLink>,
        host: Host,
        on_saved: Created,
        on_delete: Option<DeleteLink>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let name = Input::state("e.g. RDFood", window, cx);
        let search = Input::state("Search Projects", window, cx);
        if let Some(link) = &link {
            let value = link.name.clone();
            name.update(cx, |state, cx| state.set_value(value, window, cx));
        }
        let subscriptions = [&name, &search]
            .into_iter()
            .map(|input| {
                cx.subscribe(input, |_, _, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                })
            })
            .collect();
        let selected = link.as_ref().map(|link| link.project_ids.clone()).unwrap_or_default();
        let mut dialog = Self {
            host,
            link,
            projects: Vec::new(),
            loading: true,
            selected,
            name,
            search,
            error: String::new(),
            saving: false,
            on_saved,
            on_delete,
            scroll: ScrollHandle::new(),
            _subscriptions: subscriptions,
            _read: None,
            _save: None,
        };
        let future = dialog.host.list_link_projects();
        dialog._read = Some(call(window, cx, STEP, future, |this, result, _, cx| {
            match result {
                Ok(projects) => this.projects = projects,
                Err(error) => this.error = error.to_string(),
            }
            this.loading = false;
            cx.notify();
        }));
        dialog
    }

    pub fn is_loading(&self) -> bool {
        self.loading
    }

    pub fn is_saving(&self) -> bool {
        self.saving
    }

    pub fn error(&self) -> &str {
        &self.error
    }

    pub fn selected(&self) -> &[String] {
        &self.selected
    }

    pub fn name_input(&self) -> &Entity<InputState> {
        &self.name
    }

    pub fn search_input(&self) -> &Entity<InputState> {
        &self.search
    }

    /// The Projects shown: the host's, then members whose folder is gone, narrowed by the search.
    pub fn visible(&self, cx: &App) -> Vec<LinkProject> {
        let missing = self
            .link
            .iter()
            .flat_map(|link| link.project_ids.iter())
            .filter(|id| !self.projects.iter().any(|project| &project.id == *id))
            .map(|id| LinkProject {
                id: id.clone(),
                name: id.rsplit('/').nth(1).unwrap_or("Project").to_string(),
                path: "Unavailable".to_string(),
            });
        let query = self.search.read(cx).value().to_lowercase();
        self.projects
            .iter()
            .cloned()
            .chain(if self.loading { Vec::new() } else { missing.collect() })
            .filter(|project| format!("{} {}", project.name, project.path).to_lowercase().contains(&query))
            .collect()
    }

    pub fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        match self.selected.iter().position(|selected| selected == id) {
            Some(at) => {
                self.selected.remove(at);
            }
            None => self.selected.push(id.to_string()),
        }
        cx.notify();
    }

    pub fn can_save(&self, cx: &App) -> bool {
        !self.saving && self.selected.len() >= MIN_PROJECTS && !self.name.read(cx).value().trim().is_empty()
    }

    /// Creates the Link, or saves the edit.
    pub fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_save(cx) {
            return;
        }
        self.saving = true;
        self.error.clear();
        cx.notify();
        let name = self.name.read(cx).value().trim().to_string();
        let future = self.host.save_link(self.link.as_ref().map(|link| link.id.as_str()), &name, &self.selected);
        self._save = Some(call(window, cx, STEP, future, |this, result, window, cx| match result {
            Ok(link) => {
                (this.on_saved)(&link, cx);
                Dialog::close(window, cx);
            }
            Err(error) => {
                this.error = error.to_string();
                this.saving = false;
                cx.notify();
            }
        }));
    }

    fn row(&self, ix: usize, project: &LinkProject, theme: &crate::theme::Theme, cx: &mut Context<Self>) -> AnyElement {
        let checked = self.selected.contains(&project.id);
        let (view, id) = (cx.entity(), project.id.clone());
        div()
            .id(SharedString::from(format!("link-project-{ix}")))
            .debug_selector({
                let key = format!("link-project-{ix}");
                move || key.clone()
            })
            .flex()
            .flex_none()
            .h(px(52.0))
            .items_center()
            .gap(px(8.0))
            .p(px(8.0))
            .rounded(RADIUS_CONTROL)
            .cursor_pointer()
            .hover(move |row| row.bg(theme.hover))
            .on_click(move |_: &ClickEvent, _, cx| view.update(cx, |this, cx| this.toggle(&id, cx)))
            .child(Checkbox::new(SharedString::from(format!("link-project-check-{ix}")), checked).disabled(self.saving))
            .child(ProjectAvatar::new(&project.name).size(24.0))
            .child(
                div()
                    .min_w_0()
                    .child(div().truncate().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).child(project.name.clone()))
                    .child(div().truncate().text_step(TEXT_11).text_color(theme.ink3).child(project.path.clone())),
            )
            .into_any_element()
    }
}

impl Render for LinkProjectsDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let visible = self.visible(cx);
        let editing = self.link.is_some();
        let save_view = cx.entity();
        let can_save = self.can_save(cx);

        let list: Vec<AnyElement> = if self.loading {
            (0..4)
                .map(|_| {
                    div()
                        .flex()
                        .h(px(52.0))
                        .items_center()
                        .gap(px(8.0))
                        .p(px(8.0))
                        .child(Skeleton::new().size(px(24.0)))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(6.0))
                                .child(Skeleton::new().w(px(128.0)).h(px(12.0)))
                                .child(Skeleton::new().secondary().w(px(200.0)).h(px(10.0))),
                        )
                        .into_any_element()
                })
                .collect()
        } else {
            let rows: Vec<AnyElement> = visible.iter().enumerate().map(|(ix, project)| self.row(ix, project, &theme, cx)).collect();
            if rows.is_empty() && self.error.is_empty() {
                vec![EmptyState::new().size(EmptySize::Compact).title(UI_COPY.no_projects).into_any_element()]
            } else {
                rows
            }
        };

        let mut buttons: Vec<AnyElement> = Vec::new();
        let lead = self.link.clone().zip(self.on_delete.clone()).map(|(link, on_delete)| {
            Button::new("link-delete", "Delete Link\u{2026}")
                .variant(ButtonVariant::DangerGhost)
                .disabled(self.saving)
                .selector("link-delete")
                .on_click(move |_, window, cx| on_delete(&link, window, cx))
                .into_any_element()
        });
        buttons.push(
            Button::new("link-cancel", "Cancel")
                .variant(ButtonVariant::Ghost)
                .disabled(self.saving)
                .selector("link-cancel")
                .on_click(|_, window, cx| Dialog::close(window, cx))
                .into_any_element(),
        );
        let save_label = match (editing, self.saving) {
            (true, true) => UI_COPY.saving,
            (true, false) => "Save",
            (false, true) => "Creating\u{2026}",
            (false, false) => "Create Link",
        };
        buttons.push(
            Button::new("link-save", save_label)
                .disabled(!can_save)
                .selector("link-save")
                .on_click(move |_, window, cx| save_view.update(cx, |this, cx| this.save(window, cx)))
                .into_any_element(),
        );

        div()
            .flex()
            .flex_col()
            .child(div().text_step(TEXT_13).text_color(theme.ink2).child(if editing {
                LINK_UPDATE_WORKTREES_TEXT
            } else {
                LINK_CHAT_WORKTREES_TEXT
            }))
            .child(div().mt(px(16.0)).child(field_label("Link name", &theme)))
            .child(div().mt(px(4.0)).child(Input::new("link-name", &self.name)))
            .child(div().mt(px(16.0)).child(Input::new("link-search", &self.search)))
            .child(
                div()
                    .debug_selector(|| "link-list".into())
                    .mt(px(8.0))
                    .h(px(218.0))
                    .min_h_0()
                    .rounded(RADIUS_CONTROL)
                    .border_1()
                    .border_color(theme.line)
                    .p(px(4.0))
                    .child(ScrollArea::new("link-scroll", &self.scroll).children(list)),
            )
            .child(
                div()
                    .debug_selector(|| "link-count".into())
                    .mt(px(8.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .child(format!("{} selected. Choose at least two Projects.", self.selected.len())),
            )
            .child(div().mt(px(12.0)).child(InlineError::new(self.error.clone()).small()))
            .child(div().mt(px(12.0)).child(footer(lead, buttons)))
    }
}

/// Opens it: a new Link, or `link`'s edit. `on_saved` hears the Link the host answered with.
pub fn open(
    link: Option<NamedLink>,
    host: Host,
    on_saved: impl Fn(&NamedLink, &mut App) + 'static,
    on_delete: Option<DeleteLink>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<LinkProjectsDialog> {
    let title = if link.is_some() { "Edit Link" } else { "Link Projects" };
    let view = cx.new(|cx| LinkProjectsDialog::new(link, host, Rc::new(on_saved), on_delete, window, cx));
    let body = view.clone();
    Dialog::new(title).width(440.0).body(move |_, _| body.clone().into_any_element()).open(window, cx);
    view
}
