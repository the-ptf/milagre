//! Add Project (O-07; `AddProjectDialog.tsx`), with the remote folder browser: choose the computer (an offline one
//! is off), then either a folder on it or a repository to clone into one.
//!
//! - This computer keeps its folder chooser ([`DialogHost::choose_folder`]); another computer's home is browsed
//!   through `fs:list-dirs` and the checkout opens there, whose daemon owns it.
//! - A click on a folder selects it, a double-click goes into it, ".." goes up; the list is the first 500 by name.
//! - A computer that goes offline stops being read from; one that comes back reads the folder on screen again.
//! - Cloning goes into the folder picked in the list, else the one on screen (this computer: `~/Code` unless a
//!   folder was chosen).

use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, FontWeight, IntoElement, Render, Rgba, ScrollHandle, SharedString,
    Subscription, Task, Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

use super::host::{DirEntry, DirListing};
use super::{Host, STEP, call, field_label, footer};
use crate::data::{Computer, ComputerState};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonVariant, Dialog, Icon, IconName, IconSize, InlineError, Input, ScrollArea};

/// The choice of this computer in the "On" row.
pub const THIS_MAC: &str = "this-mac";
const CODE_FOLDER: &str = "~/Code";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Open,
    Clone,
}

type Opened = Rc<dyn Fn(&str, &mut App)>;

pub struct AddProjectDialog {
    host: Host,
    this_mac: String,
    computers: Vec<Computer>,
    on: String,
    mode: Mode,
    listing: Option<DirListing>,
    selected: Option<DirEntry>,
    url: Entity<InputState>,
    /// This computer's clone folder, from its own chooser; `None` is `~/Code`.
    parent: Option<String>,
    error: Option<String>,
    busy: bool,
    /// The newest folder read; an older answer is dropped.
    reads: usize,
    was_reachable: bool,
    scroll: ScrollHandle,
    on_opened: Opened,
    _subscriptions: Vec<Subscription>,
    _read: Option<Task<()>>,
    _work: Option<Task<()>>,
}

fn dot(theme: &Theme, state: Option<ComputerState>) -> Rgba {
    match state {
        None | Some(ComputerState::Online) => theme.green,
        Some(ComputerState::Connecting | ComputerState::Reconnecting) => theme.orange,
        Some(ComputerState::Offline | ComputerState::Refused) => theme.red,
        Some(ComputerState::Off) => theme.ink3,
    }
}

/// The line under a computer's name in the "On" row.
pub fn route_line(state: ComputerState) -> &'static str {
    match state {
        ComputerState::Online => "Online",
        ComputerState::Connecting => "Connecting\u{2026}",
        ComputerState::Reconnecting => "Reconnecting\u{2026}",
        ComputerState::Offline => "Offline",
        ComputerState::Refused => "Refused",
        ComputerState::Off => "Off",
    }
}

impl AddProjectDialog {
    fn new(host: Host, this_mac: &str, computers: Vec<Computer>, on_opened: Opened, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let url = Input::state("https://github.com/owner/repository", window, cx);
        let subscriptions = vec![cx.subscribe_in(&url, window, |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::Change => cx.notify(),
            InputEvent::PressEnter { .. } if this.can_clone(cx) => this.clone_repository(window, cx),
            _ => {}
        })];
        Self {
            host,
            this_mac: this_mac.to_string(),
            computers,
            on: THIS_MAC.to_string(),
            mode: Mode::Open,
            listing: None,
            selected: None,
            url,
            parent: None,
            error: None,
            busy: false,
            reads: 0,
            was_reachable: true,
            scroll: ScrollHandle::new(),
            on_opened,
            _subscriptions: subscriptions,
            _read: None,
            _work: None,
        }
    }

    pub fn on(&self) -> &str {
        &self.on
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn listing(&self) -> Option<&DirListing> {
        self.listing.as_ref()
    }

    pub fn selected(&self) -> Option<&DirEntry> {
        self.selected.as_ref()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    pub fn url_input(&self) -> &Entity<InputState> {
        &self.url
    }

    fn computer(&self) -> Option<&Computer> {
        self.computers.iter().find(|computer| computer.id.as_ref() == self.on)
    }

    /// This computer, or the paired one chosen when it is online.
    pub fn reachable(&self) -> bool {
        self.computer().is_none_or(|computer| computer.state == ComputerState::Online)
    }

    /// Where a clone goes: the folder picked in the list, else the one on screen; this computer's own choice.
    pub fn clone_into(&self) -> Option<String> {
        if self.computer().is_some() {
            self.selected.as_ref().map(|entry| entry.path.clone()).or_else(|| self.listing.as_ref().map(|listing| listing.path.clone()))
        } else {
            self.parent.clone()
        }
    }

    pub fn can_clone(&self, cx: &App) -> bool {
        let remote_ok = self.computer().is_none() || (self.reachable() && self.clone_into().is_some());
        !self.url.read(cx).value().trim().is_empty() && !self.busy && remote_ok
    }

    pub fn can_add(&self) -> bool {
        self.computer().is_some()
            && self.reachable()
            && !self.busy
            && self.selected.as_ref().is_some_and(|entry| entry.git || entry.project)
    }

    pub fn choose_computer(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let away = self.computers.iter().any(|computer| computer.id.as_ref() == id && computer.state != ComputerState::Online);
        if away || self.on == id {
            return;
        }
        // A new computer drops what the last one was reading, so a late listing or error can't land on this pane.
        self.reads += 1;
        self.on = id.to_string();
        self.listing = None;
        self.selected = None;
        self.error = None;
        self._read = None;
        if self.on != THIS_MAC {
            self.browse(None, window, cx);
        }
        cx.notify();
    }

    pub fn set_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.mode = mode;
        cx.notify();
    }

    /// Reads a folder of the chosen computer (its home without a path).
    pub fn browse(&mut self, path: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(computer) = self.computer().filter(|computer| computer.state == ComputerState::Online).map(|c| c.id.to_string()) else {
            return;
        };
        self.reads += 1;
        let read = self.reads;
        self.selected = None;
        self.error = None;
        let future = self.host.list_dirs(Some(&computer), path.as_deref());
        self._read = Some(call(window, cx, std::time::Duration::ZERO, future, move |this, result, _, cx| {
            if read != this.reads {
                return;
            }
            match result {
                Ok(listing) => this.listing = Some(listing),
                Err(error) => this.error = Some(error.to_string()),
            }
            cx.notify();
        }));
        cx.notify();
    }

    pub fn select(&mut self, entry: DirEntry, cx: &mut Context<Self>) {
        self.selected = Some(entry);
        cx.notify();
    }

    /// The chosen computer's state changed (the window pushes `computers:list`): offline stops the reads, and a
    /// computer back from away reads the folder on screen again.
    pub fn set_computers(&mut self, computers: Vec<Computer>, window: &mut Window, cx: &mut Context<Self>) {
        self.computers = computers;
        if self.on != THIS_MAC && self.computer().is_none() {
            self.on = THIS_MAC.to_string();
            self.listing = None;
            self.selected = None;
        }
        let reachable = self.reachable();
        if !reachable {
            self.reads += 1;
        }
        if reachable && !self.was_reachable && self.on != THIS_MAC {
            let at = self.listing.as_ref().map(|listing| listing.path.clone());
            self.browse(at, window, cx);
        }
        self.was_reachable = reachable;
        cx.notify();
    }

    fn finish(&mut self, result: anyhow::Result<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.busy = false;
        match result {
            Ok(name) => {
                (self.on_opened)(&name, cx);
                Dialog::close(window, cx);
            }
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }

    /// This computer: its folder chooser, then the folder opens as a Project.
    pub fn choose_here(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.error = None;
        let chooser = self.host.choose_folder();
        let host = self.host.clone();
        self._work = Some(cx.spawn_in(window, async move |this, cx| {
            let chosen = chooser.await;
            let opened = match chosen {
                Ok(Some(path)) => Some(host.open_project_at(crate::data::LOCAL, &path).await),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            };
            if let Some(result) = opened {
                this.update_in(cx, |this, window, cx| this.finish(result, window, cx)).ok();
            }
        }));
    }

    /// This computer's clone folder, from its own chooser.
    pub fn choose_parent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.error = None;
        let future = self.host.choose_folder();
        self._work = Some(call(window, cx, std::time::Duration::ZERO, future, |this, result, _, cx| {
            match result {
                Ok(Some(path)) => this.parent = Some(path),
                Ok(None) => {}
                Err(error) => this.error = Some(error.to_string()),
            }
            cx.notify();
        }));
    }

    pub fn clone_repository(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_clone(cx) {
            return;
        }
        self.busy = true;
        self.error = None;
        cx.notify();
        let url = self.url.read(cx).value().trim().to_string();
        let computer = self.computer().map(|computer| computer.id.to_string());
        let future = self.host.clone_project(computer.as_deref(), &url, self.clone_into().as_deref());
        self._work = Some(call(window, cx, STEP, future, |this, result, window, cx| this.finish(result, window, cx)));
    }

    pub fn add_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(entry), Some(computer)) = (self.selected.clone().filter(|_| self.can_add()), self.computer().map(|c| c.id.to_string()))
        else {
            return;
        };
        self.busy = true;
        self.error = None;
        cx.notify();
        let future = self.host.open_project_at(&computer, &entry.path);
        self._work = Some(call(window, cx, STEP, future, |this, result, window, cx| this.finish(result, window, cx)));
    }

    fn choice(&self, id: &str, name: &str, line: &str, state: Option<ComputerState>, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let on = self.on == id;
        let away = state.is_some_and(|state| state != ComputerState::Online);
        let (view, pick) = (cx.entity(), id.to_string());
        let selector = format!("add-project-on-{id}");
        let tone = dot(theme, state);
        div()
            .id(SharedString::from(selector.clone()))
            .debug_selector(move || selector.clone())
            .flex()
            .h(px(44.0))
            .min_w_0()
            .flex_1()
            .items_center()
            .gap(px(8.0))
            .px(px(12.0))
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(if on { theme.ink } else { theme.line_strong })
            .when(on, |el| el.bg(theme.hover2))
            .when(away, |el| el.opacity(0.4))
            .when(!away, |el| {
                let hover = theme.hover;
                el.cursor_pointer().when(!on, move |el| el.hover(move |s| s.bg(hover)))
            })
            .on_click(move |_: &ClickEvent, window, cx| view.update(cx, |this, cx| this.choose_computer(&pick, window, cx)))
            .child(div().flex_none().size(px(8.0)).rounded_full().bg(tone))
            .child(
                div()
                    .min_w_0()
                    .child(div().truncate().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).child(name.to_string()))
                    .child(div().truncate().text_step(TEXT_11).text_color(theme.ink3).child(line.to_string())),
            )
            .into_any_element()
    }

    fn mode_choice(&self, mode: Mode, name: &str, line: &str, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let on = self.mode == mode;
        let view = cx.entity();
        let selector = if mode == Mode::Open { "add-project-mode-open" } else { "add-project-mode-clone" };
        div()
            .id(selector)
            .debug_selector(move || selector.to_string())
            .flex()
            .h(px(44.0))
            .min_w_0()
            .flex_1()
            .items_center()
            .px(px(12.0))
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(if on { theme.ink } else { theme.line_strong })
            .when(on, |el| el.bg(theme.hover2))
            .cursor_pointer()
            .on_click(move |_: &ClickEvent, _, cx| view.update(cx, |this, cx| this.set_mode(mode, cx)))
            .child(
                div()
                    .min_w_0()
                    .child(div().truncate().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).child(name.to_string()))
                    .child(div().truncate().text_step(TEXT_11).text_color(theme.ink3).child(line.to_string())),
            )
            .into_any_element()
    }

    fn folder_browser(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let name = self.computer().map(|computer| computer.name.to_string()).unwrap_or_default();
        let crumbs: Vec<String> = self.listing.as_ref().map_or_else(Vec::new, |listing| {
            std::iter::once("~".to_string())
                .chain(
                    listing.path.strip_prefix(&listing.home).unwrap_or("").split('/').filter(|part| !part.is_empty()).map(str::to_string),
                )
                .collect()
        });
        let mut rows: Vec<AnyElement> = Vec::new();
        if let Some(parent) = self.listing.as_ref().and_then(|listing| listing.parent.clone()) {
            let view = cx.entity();
            rows.push(
                div()
                    .id("add-project-up")
                    .debug_selector(|| "add-project-up".into())
                    .flex()
                    .h(px(32.0))
                    .items_center()
                    .px(px(12.0))
                    .border_b_1()
                    .border_color(theme.line)
                    .text_step(TEXT_13)
                    .text_color(theme.ink2)
                    .cursor_pointer()
                    .on_click(move |_: &ClickEvent, window, cx| view.update(cx, |this, cx| this.browse(Some(parent.clone()), window, cx)))
                    .child("..")
                    .into_any_element(),
            );
        }
        for (ix, entry) in self.listing.iter().flat_map(|listing| listing.entries.iter()).enumerate() {
            let picked = self.selected.as_ref().is_some_and(|selected| selected.path == entry.path);
            let (view, target) = (cx.entity(), entry.clone());
            let tag = if entry.project {
                Some("Added".to_string())
            } else {
                entry.git.then(|| format!("git \u{b7} {}", entry.branch.as_deref().unwrap_or("detached")))
            };
            let hover = theme.hover;
            rows.push(
                div()
                    .id(SharedString::from(format!("add-project-folder-{ix}")))
                    .debug_selector({
                        let key = format!("add-project-folder-{ix}");
                        move || key.clone()
                    })
                    .flex()
                    .h(px(32.0))
                    .items_center()
                    .gap(px(8.0))
                    .px(px(12.0))
                    .border_b_1()
                    .border_color(theme.line)
                    .text_step(TEXT_13)
                    .text_color(if picked { theme.ink } else { theme.ink2 })
                    .when(picked, |row| row.bg(theme.hover2))
                    .when(!picked, move |row| row.hover(move |s| s.bg(hover)))
                    .cursor_pointer()
                    .on_click(move |event: &ClickEvent, window, cx| {
                        let target = target.clone();
                        view.update(cx, |this, cx| {
                            if event.click_count() >= 2 {
                                this.browse(Some(target.path.clone()), window, cx);
                            } else {
                                this.select(target, cx);
                            }
                        })
                    })
                    .child(Icon::new(IconName::Folder01).size(IconSize::S16).color(theme.ink2))
                    .child(div().min_w_0().flex_1().truncate().child(entry.name.clone()))
                    .when_some(tag, |row, tag| row.child(div().flex_none().text_step(TEXT_11).text_color(theme.ink3).child(tag)))
                    .into_any_element(),
            );
        }
        div()
            .flex()
            .flex_col()
            .child(div().mt(px(16.0)).child(field_label(
                if self.mode == Mode::Clone { format!("Clone into a folder on {name}") } else { format!("Folder on {name}") },
                theme,
            )))
            .when(!self.reachable(), |col| {
                col.child(
                    div()
                        .debug_selector(|| "add-project-away".into())
                        .mt(px(4.0))
                        .text_step(TEXT_13)
                        .text_color(theme.ink2)
                        .child(format!("{name} is offline. Pick another computer or wait for it to come back.")),
                )
            })
            .child(
                div()
                    .debug_selector(|| "add-project-path".into())
                    .mt(px(4.0))
                    .flex()
                    .h(px(36.0))
                    .items_center()
                    .gap(px(4.0))
                    .px(px(10.0))
                    .rounded(RADIUS_CONTROL)
                    .border_1()
                    .border_color(theme.line_strong)
                    .bg(theme.field)
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .children(crumbs.iter().enumerate().map(|(ix, crumb)| {
                        let last = ix + 1 == crumbs.len() && ix > 0;
                        div().when(last, |el| el.font_weight(FontWeight::MEDIUM).text_color(theme.ink)).child(format!("{crumb} /"))
                    })),
            )
            .child(
                div()
                    .debug_selector(|| "add-project-folders".into())
                    .mt(px(8.0))
                    .h(px(256.0))
                    .rounded(RADIUS_CARD)
                    .border_1()
                    .border_color(theme.line)
                    .overflow_hidden()
                    .child(ScrollArea::new("add-project-scroll", &self.scroll).children(rows)),
            )
            .when(self.listing.as_ref().is_some_and(|listing| listing.truncated), |col| {
                col.child(div().mt(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child("Showing the first 500 folders."))
            })
            .into_any_element()
    }
}

impl Render for AddProjectDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let clone_mode = self.mode == Mode::Clone;
        let computer_name = self.computer().map(|computer| computer.name.to_string());
        let mut body = div().flex().flex_col();

        if !self.computers.is_empty() {
            let mut choices = vec![self.choice(THIS_MAC, &self.this_mac.clone(), "This computer", None, &theme, cx)];
            for computer in self.computers.clone() {
                choices.push(self.choice(&computer.id, &computer.name, route_line(computer.state), Some(computer.state), &theme, cx));
            }
            body = body
                .child(div().mt(px(16.0)).child(field_label("On", &theme)))
                .child(div().mt(px(4.0)).flex().gap(px(6.0)).children(choices));
        }
        body = body.child(div().mt(px(16.0)).child(field_label("Add", &theme))).child(
            div()
                .mt(px(4.0))
                .flex()
                .gap(px(6.0))
                .child(self.mode_choice(Mode::Open, "Open a folder", "A folder that is already there", &theme, cx))
                .child(self.mode_choice(Mode::Clone, "Clone a repository", "From a GitHub or Git address", &theme, cx)),
        );
        if clone_mode {
            body = body
                .child(div().mt(px(16.0)).child(field_label("Repository address", &theme)))
                .child(div().mt(px(4.0)).child(Input::new("add-project-url", &self.url).disabled(self.busy)));
        }
        if computer_name.is_none() {
            let (parent_view, here_view) = (view.clone(), view.clone());
            body = if clone_mode {
                body.child(div().mt(px(16.0)).child(field_label("Clone into", &theme))).child(
                    div()
                        .mt(px(4.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .debug_selector(|| "add-project-clone-folder".into())
                                .flex()
                                .h(px(36.0))
                                .min_w_0()
                                .flex_1()
                                .items_center()
                                .px(px(10.0))
                                .rounded(RADIUS_CONTROL)
                                .border_1()
                                .border_color(theme.line_strong)
                                .bg(theme.field)
                                .text_step(TEXT_13)
                                .text_color(theme.ink2)
                                .child(div().truncate().child(self.parent.clone().unwrap_or_else(|| CODE_FOLDER.to_string()))),
                        )
                        .child(
                            Button::new("add-project-parent", "Choose folder\u{2026}")
                                .variant(ButtonVariant::Secondary)
                                .disabled(self.busy)
                                .selector("add-project-parent")
                                .on_click(move |_, window, cx| parent_view.update(cx, |this, cx| this.choose_parent(window, cx))),
                        ),
                )
            } else {
                body.child(
                    div()
                        .mt(px(16.0))
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.0))
                        .child(div().text_step(TEXT_13).text_color(theme.ink2).child("Choose a folder on this computer."))
                        .child(
                            Button::new("add-project-choose", "Choose folder\u{2026}")
                                .variant(ButtonVariant::Secondary)
                                .selector("add-project-choose")
                                .on_click(move |_, window, cx| here_view.update(cx, |this, cx| this.choose_here(window, cx))),
                        ),
                )
            };
        } else {
            body = body.child(self.folder_browser(&theme, cx));
        }
        body = body.child(div().mt(px(12.0)).child(InlineError::new(self.error.clone().unwrap_or_default())));

        let (clone_view, add_view) = (view.clone(), view);
        let primary: Option<AnyElement> = if clone_mode {
            Some(
                Button::new("add-project-clone", if self.busy { "Cloning\u{2026}" } else { "Clone" })
                    .disabled(!self.can_clone(cx))
                    .selector("add-project-clone")
                    .on_click(move |_, window, cx| clone_view.update(cx, |this, cx| this.clone_repository(window, cx)))
                    .into_any_element(),
            )
        } else {
            self.computer().map(|_| {
                let label = match &self.selected {
                    Some(entry) => format!("{} {}", if entry.project { "Open" } else { "Add" }, entry.name),
                    None => "Add Project".to_string(),
                };
                Button::new("add-project-add", label)
                    .disabled(!self.can_add())
                    .selector("add-project-add")
                    .on_click(move |_, window, cx| add_view.update(cx, |this, cx| this.add_selected(window, cx)))
                    .into_any_element()
            })
        };
        let mut buttons = vec![
            Button::new("add-project-cancel", "Cancel")
                .variant(ButtonVariant::Ghost)
                .selector("add-project-cancel")
                .on_click(|_, window, cx| Dialog::close(window, cx))
                .into_any_element(),
        ];
        buttons.extend(primary);
        let note = computer_name.map(|name| {
            div()
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child(format!(
                    "{} on {name}. Its daemon owns the Project; this window drives it.",
                    if clone_mode { "Clones" } else { "Opens" }
                ))
                .into_any_element()
        });
        body.child(div().mt(px(16.0)).child(footer(note, buttons)))
    }
}

/// Opens it. `computers` are the paired ones (offline ones are off); `on_opened` hears the Project's name.
pub fn open(
    host: Host,
    this_mac: &str,
    computers: Vec<Computer>,
    on_opened: impl Fn(&str, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> Entity<AddProjectDialog> {
    let view = cx.new(|cx| AddProjectDialog::new(host, this_mac, computers, Rc::new(on_opened), window, cx));
    let body = view.clone();
    Dialog::new("Add Project").width(520.0).body(move |_, _| body.clone().into_any_element()).open(window, cx);
    view
}
