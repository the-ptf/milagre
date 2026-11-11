//! The Link popovers (S-15, `LinkPopover` and `LinkPicker` in `components/sidebar/SidebarLinks.tsx`).
//!
//! - [`LinkPopover`]: asks before a Link is made; nothing is created until Create Link. What it joins (only these
//!   Worktrees, or the whole Projects when the two Chats are in different ones), Always allow Delegations, and an
//!   optional message the source Chat gets ("Create Link and ask"). Escape or a press outside cancels; ⌘↩ confirms.
//! - [`LinkPicker`]: "Link with…" (every other Chat, filtered as you type, Up and Down move the highlight, Return
//!   picks) or "Remove Link with…" (the Chat's Links). A Chat that can't be picked says why and is dimmed.
//!
//! Both are views the sidebar opens beside itself (`links.rs`) and hear back from through their events.

use gpui::{
    App, ClickEvent, Context, Entity, EventEmitter, FocusHandle, FontWeight, KeyDownEvent, SharedString, Subscription, Window, div,
    prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState, TextareaState};

use super::links::{LinkChat, LinkScope};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonVariant, Checkbox, FieldSize, Icon, IconName, IconSize, Input, TextArea};

/// The popover's and the picker's widths (`POPOVER_WIDTH`, `PICKER_WIDTH`).
pub const POPOVER_WIDTH: f32 = 320.0;
pub const PICKER_WIDTH: f32 = 300.0;
/// The picker's list stops growing here and scrolls (`max-h-[360px]`, less the title and the field).
const PICKER_LIST_MAX: f32 = 280.0;

/// What the Create Link popover asks about.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkAsk {
    pub source: LinkChat,
    pub target: LinkChat,
    /// The two Chats are in different Projects, so the whole Projects can be linked.
    pub projects: bool,
    /// "Link and ask" is offered.
    pub can_ask: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PopoverEvent {
    Confirm { scope: LinkScope, allow: bool, text: String },
    Cancel,
}

pub struct LinkPopover {
    ask: LinkAsk,
    scope: LinkScope,
    allow: bool,
    text: Entity<TextareaState>,
    focus: FocusHandle,
    _text_events: Subscription,
}

impl EventEmitter<PopoverEvent> for LinkPopover {}

impl LinkPopover {
    pub fn new(ask: LinkAsk, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let placeholder = format!("What should it ask “{}” to do?", ask.target.label);
        let text = TextArea::state(placeholder, (3, 8), window, cx);
        let text_events = cx.subscribe(&text, |_, _, _: &InputEvent, cx| cx.notify());
        Self { ask, scope: LinkScope::Worktrees, allow: false, text, focus: cx.focus_handle(), _text_events: text_events }
    }

    pub fn ask(&self) -> &LinkAsk {
        &self.ask
    }

    pub fn scope(&self) -> LinkScope {
        self.scope
    }

    pub fn allow(&self) -> bool {
        self.allow
    }

    /// Focus goes to the popover, so Escape and ⌘↩ reach it (the desktop focuses Create Link).
    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    pub fn set_scope(&mut self, scope: LinkScope, cx: &mut Context<Self>) {
        self.scope = scope;
        cx.notify();
    }

    pub fn set_allow(&mut self, allow: bool, cx: &mut Context<Self>) {
        self.allow = allow;
        cx.notify();
    }

    pub fn set_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.to_string();
        self.text.update(cx, |state, cx| state.set_value(text, window, cx));
        cx.notify();
    }

    fn text_value(&self, cx: &App) -> String {
        if self.ask.can_ask { self.text.read(cx).value().to_string() } else { String::new() }
    }

    /// Create Link's label: "Create Link and ask" once there is something to ask.
    pub fn confirm_label(&self, cx: &App) -> &'static str {
        if self.ask.can_ask && !self.text_value(cx).trim().is_empty() { "Create Link and ask" } else { "Create Link" }
    }

    pub fn confirm(&mut self, cx: &mut Context<Self>) {
        let text = self.text_value(cx);
        cx.emit(PopoverEvent::Confirm { scope: self.scope, allow: self.allow, text });
    }

    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        cx.emit(PopoverEvent::Cancel);
    }

    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let keys = &event.keystroke;
        if keys.key == "escape" {
            cx.stop_propagation();
            self.cancel(cx);
        } else if keys.key == "enter" && (keys.modifiers.platform || keys.modifiers.control) {
            cx.stop_propagation();
            self.confirm(cx);
        }
    }
}

impl Render for LinkPopover {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let ask = &self.ask;
        let whole = self.scope == LinkScope::Projects;
        let (left, right) =
            if whole { (ask.source.project.clone(), ask.target.project.clone()) } else { (ask.source.side_name(), ask.target.side_name()) };
        let choices = [
            (LinkScope::Worktrees, "Only these Worktrees", format!("{} and {}", ask.source.side_name(), ask.target.side_name())),
            (
                LinkScope::Projects,
                "The whole Projects",
                format!("Every Worktree of {} and {}, new ones too", ask.source.project, ask.target.project),
            ),
        ];
        let scope = self.scope;
        let radios = ask.projects.then(|| {
            div().debug_selector(|| "link-scope".into()).mt(px(10.0)).flex().flex_col().gap(px(1.0)).children(choices.into_iter().map(
                |(key, label, detail)| {
                    let checked = scope == key;
                    let id = match key {
                        LinkScope::Worktrees => "link-scope-worktrees",
                        LinkScope::Projects => "link-scope-projects",
                    };
                    let hover = theme.hover;
                    div()
                        .id(id)
                        .debug_selector(move || id.into())
                        .flex()
                        .items_start()
                        .gap(px(8.0))
                        .px(px(8.0))
                        .py(px(6.0))
                        .rounded(RADIUS_CONTROL)
                        .cursor_pointer()
                        .when(checked, |el| el.bg(theme.hover2))
                        .when(!checked, |el| el.hover(move |style| style.bg(hover)))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.set_scope(key, cx)))
                        .child(
                            div()
                                .mt(px(2.0))
                                .flex()
                                .flex_none()
                                .size(px(16.0))
                                .items_center()
                                .justify_center()
                                .when(checked, |el| el.child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink))),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .child(div().text_step(TEXT_13).text_color(theme.ink).child(label))
                                .child(div().text_step(TEXT_11).text_color(theme.ink3).child(detail)),
                        )
                },
            ))
        });
        let allow = self.allow;
        let ask_field = ask.can_ask.then(|| {
            div()
                .mt(px(10.0))
                .child(
                    div()
                        .text_step(TEXT_12)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink2)
                        .child(format!("Ask “{}” (optional)", ask.source.label)),
                )
                .child(div().mt(px(4.0)).child(TextArea::new("link-ask", &self.text)))
        });
        let label = self.confirm_label(cx);
        div()
            .id("link-popover")
            .debug_selector(|| "link-popover".into())
            .key_context("LinkPopover")
            .track_focus(&self.focus)
            .occlude()
            .w(px(POPOVER_WIDTH))
            .p(px(12.0))
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(theme.shadow_raised())
            .text_color(theme.ink)
            .capture_key_down(cx.listener(Self::on_key))
            .on_mouse_down_out(cx.listener(|this, _, _, cx| this.cancel(cx)))
            .child(div().text_step(TEXT_13).font_weight(FontWeight::SEMIBOLD).child(if whole {
                "Link these Projects?"
            } else {
                "Link these Worktrees?"
            }))
            .child(
                div()
                    .debug_selector(|| "link-sides".into())
                    .mt(px(6.0))
                    .flex()
                    .min_w_0()
                    .items_center()
                    .gap(px(6.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(div().min_w_0().truncate().child(left))
                    .child(Icon::new(IconName::Link04).size(IconSize::S12).color(theme.ink3))
                    .child(div().min_w_0().truncate().child(right)),
            )
            .children(radios)
            .child(div().mt(px(8.0)).text_step(TEXT_12).text_color(theme.ink3).child(format!(
                "Every Chat on either side can read the other side and make Delegations to it, so “{}” can ask “{}” for changes.",
                ask.source.label, ask.target.label
            )))
            .child(
                div().debug_selector(|| "link-always-allow".into()).mt(px(10.0)).flex().flex_col().gap(px(2.0)).child(
                    div()
                        .id("link-allow-row")
                        .flex()
                        .items_start()
                        .gap(px(8.0))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                            let on = !this.allow;
                            this.set_allow(on, cx)
                        }))
                        .child(div().mt(px(1.0)).flex_none().child(Checkbox::new("link-allow", allow)))
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .child(
                                    div()
                                        .text_step(TEXT_13)
                                        .text_color(theme.ink)
                                        .child(format!("Always allow Delegations from “{}”", ask.source.label)),
                                )
                                .child(
                                    div()
                                        .text_step(TEXT_11)
                                        .text_color(theme.ink3)
                                        .child("Same as “Always allow for this Link in this chat” on the approval card."),
                                ),
                        ),
                ),
            )
            .children(ask_field)
            .child(
                div()
                    .mt(px(12.0))
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .child(
                        Button::new("link-cancel", "Cancel")
                            .variant(ButtonVariant::Ghost)
                            .selector("link-cancel")
                            .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                    )
                    .child(
                        Button::new("link-confirm", label)
                            .selector("link-confirm")
                            .on_click(cx.listener(|this, _, _, cx| this.confirm(cx))),
                    ),
            )
    }
}

/// Which list the picker shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickerMode {
    /// "Link with…": every other Chat.
    Link,
    /// "Remove Link with…": the Chat's Links.
    Remove,
}

/// One entry: a Chat key (Link) or a Link id (Remove), and why it can't be picked.
#[derive(Clone, Debug, PartialEq)]
pub struct PickerEntry {
    pub key: String,
    pub title: SharedString,
    pub detail: Option<SharedString>,
    pub problem: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PickerEvent {
    Pick(String),
    Close,
}

pub struct LinkPicker {
    mode: PickerMode,
    source: LinkChat,
    entries: Vec<PickerEntry>,
    search: Entity<InputState>,
    /// The highlighted entry among the pickable ones that match.
    active: usize,
    focus: FocusHandle,
    _search_events: Subscription,
}

impl EventEmitter<PickerEvent> for LinkPicker {}

impl LinkPicker {
    pub fn new(mode: PickerMode, source: LinkChat, entries: Vec<PickerEntry>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = Input::state("Search chats", window, cx);
        let search_events = cx.subscribe(&search, |this, _, event: &InputEvent, cx| match event {
            InputEvent::Change => {
                this.active = 0;
                cx.notify();
            }
            InputEvent::PressEnter { .. } => this.pick_active(cx),
            _ => {}
        });
        Self { mode, source, entries, search, active: 0, focus: cx.focus_handle(), _search_events: search_events }
    }

    pub fn mode(&self) -> PickerMode {
        self.mode
    }

    pub fn source(&self) -> &LinkChat {
        &self.source
    }

    /// Focus goes to the search field ("Link with…") or the picker ("Remove Link with…").
    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        match self.mode {
            PickerMode::Link => self.search.update(cx, |state, cx| state.focus(window, cx)),
            PickerMode::Remove => window.focus(&self.focus, cx),
        }
    }

    pub fn set_query(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        let query = query.to_string();
        self.search.update(cx, |state, cx| state.set_value(query, window, cx));
        self.active = 0;
        cx.notify();
    }

    /// The entries that match the search, every word anywhere in the title or detail.
    pub fn shown(&self, cx: &App) -> Vec<PickerEntry> {
        let query = if self.mode == PickerMode::Link { self.search.read(cx).value().to_lowercase() } else { String::new() };
        let words: Vec<&str> = query.split_whitespace().collect();
        self.entries
            .iter()
            .filter(|entry| {
                let haystack = format!("{} {}", entry.title, entry.detail.as_deref().unwrap_or_default()).to_lowercase();
                words.iter().all(|word| haystack.contains(word))
            })
            .cloned()
            .collect()
    }

    fn pickable(&self, cx: &App) -> Vec<PickerEntry> {
        self.shown(cx).into_iter().filter(|entry| entry.problem.is_none()).collect()
    }

    /// The highlighted entry's key.
    pub fn active_key(&self, cx: &App) -> Option<String> {
        let pickable = self.pickable(cx);
        pickable.get(self.active.min(pickable.len().saturating_sub(1))).map(|entry| entry.key.clone())
    }

    pub fn move_active(&mut self, step: isize, cx: &mut Context<Self>) {
        let count = self.pickable(cx).len();
        if count == 0 {
            return;
        }
        self.active = (self.active.min(count - 1) as isize + step).rem_euclid(count as isize) as usize;
        cx.notify();
    }

    pub fn pick_active(&mut self, cx: &mut Context<Self>) {
        if let Some(key) = self.active_key(cx) {
            cx.emit(PickerEvent::Pick(key));
        }
    }

    pub fn pick(&mut self, key: &str, cx: &mut Context<Self>) {
        if self.entries.iter().any(|entry| entry.key == key && entry.problem.is_none()) {
            cx.emit(PickerEvent::Pick(key.to_string()));
        }
    }

    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "escape" => {
                cx.stop_propagation();
                cx.emit(PickerEvent::Close);
            }
            "down" | "up" if self.mode == PickerMode::Link => {
                cx.stop_propagation();
                self.move_active(if event.keystroke.key == "down" { 1 } else { -1 }, cx);
            }
            _ => {}
        }
    }

    fn entry(&self, ix: usize, entry: &PickerEntry, highlighted: bool, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let disabled = entry.problem.is_some();
        let hover = theme.hover2;
        let key = entry.key.clone();
        let icon = if self.mode == PickerMode::Link { IconName::Link04 } else { IconName::Unlink04 };
        div()
            .id(("link-entry", ix))
            .debug_selector(move || format!("link-entry-{ix}"))
            .flex()
            .items_center()
            .gap(px(8.0))
            .px(px(8.0))
            .py(px(6.0))
            .rounded(RADIUS_CONTROL)
            .when(disabled, |el| el.opacity(0.5))
            .when(highlighted, |el| el.bg(theme.hover2))
            .when(!disabled && !highlighted, |el| el.cursor_pointer().hover(move |style| style.bg(hover)))
            .when(!disabled, |el| el.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.pick(&key, cx))))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .size(px(20.0))
                    .items_center()
                    .justify_center()
                    .child(Icon::new(icon).size(IconSize::S14).color(theme.ink2)),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(div().truncate().text_step(TEXT_13).text_color(theme.ink).child(entry.title.clone()))
                    .children(entry.detail.clone().map(|detail| div().truncate().text_step(TEXT_11).text_color(theme.ink3).child(detail))),
            )
            .children(entry.problem.map(|problem| div().flex_none().text_step(TEXT_11).text_color(theme.ink3).child(problem)))
    }
}

impl Render for LinkPicker {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let title = match self.mode {
            PickerMode::Link => format!("Link “{}” with…", self.source.label),
            PickerMode::Remove => format!("Remove a Link of “{}”", self.source.label),
        };
        let shown = self.shown(cx);
        let active = self.active_key(cx);
        let rows: Vec<_> = shown
            .iter()
            .enumerate()
            .map(|(ix, entry)| {
                let highlighted = self.mode == PickerMode::Link && active.as_deref() == Some(entry.key.as_str());
                self.entry(ix, entry, highlighted, &theme, cx).into_any_element()
            })
            .collect();
        let empty = shown.is_empty().then(|| {
            let text = if !self.entries.is_empty() {
                "No chats match."
            } else if self.mode == PickerMode::Link {
                "No other chats to link."
            } else {
                "No Links."
            };
            div().debug_selector(|| "link-empty".into()).px(px(8.0)).py(px(8.0)).text_step(TEXT_12).text_color(theme.ink3).child(text)
        });
        div()
            .id("link-picker")
            .debug_selector(|| "link-picker".into())
            .key_context("LinkPicker")
            .track_focus(&self.focus)
            .occlude()
            .flex()
            .flex_col()
            .w(px(PICKER_WIDTH))
            .p(px(6.0))
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(theme.shadow_raised())
            .text_color(theme.ink)
            .capture_key_down(cx.listener(Self::on_key))
            .on_mouse_down_out(cx.listener(|_, _, _, cx| cx.emit(PickerEvent::Close)))
            .child(
                div()
                    .truncate()
                    .px(px(8.0))
                    .pt(px(4.0))
                    .pb(px(4.0))
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink3)
                    .child(title),
            )
            .when(self.mode == PickerMode::Link, |el| {
                el.child(div().mx(px(4.0)).mb(px(4.0)).child(Input::new("link-search", &self.search).size(FieldSize::S32)))
            })
            .child(
                div()
                    .id("link-entries")
                    .flex()
                    .flex_col()
                    .gap(px(1.0))
                    .max_h(px(PICKER_LIST_MAX))
                    .overflow_y_scroll()
                    .children(rows)
                    .children(empty),
            )
    }
}
