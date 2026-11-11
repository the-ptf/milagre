//! The Routine prompt with its `{{` list (R-05: `PlaceholderTextarea.tsx`): a text area where typing `{{` lists the
//! trigger's placeholders, with an example of each, in a list under the text area. Up and Down move, Enter or Tab
//! inserts, Escape dismisses (and goes no further, so the form stays open).
//!
//! The text area is gpui-component's (`TextareaState`); the list is ours, driven by `prompt::placeholder_query` over the
//! text and caret, and its keys are caught before the text area sees them (`capture_action`), as the composer's menus are.

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FontWeight, IntoElement, Render, SharedString, Subscription, Window, deferred, div,
    prelude::*, px,
};
use gpui_component::input::{Enter, Escape, IndentInline, InputEvent, MoveDown, MoveUp, TextareaState};

use super::prompt::{Placeholder, PlaceholderQuery, dynamic_prefix, insert_placeholder, placeholder_query};
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_11, TEXT_13, TextStepExt};
use crate::ui::{Icon, IconName, IconSize, TextArea};

/// The list's rows are menu rows: 32px, in a 6px padded raised card at most 280px tall.
const ROW_HEIGHT: f32 = 32.0;
const MAX_LIST: f32 = 280.0;
const LIST_WIDTH: f32 = 320.0;

pub enum PromptEvent {
    Changed,
}

pub struct PromptField {
    state: Entity<TextareaState>,
    placeholders: Vec<Placeholder>,
    open: Option<PlaceholderQuery>,
    active: usize,
    /// The `{{` the user dismissed with Escape; it stays closed until they start another.
    dismissed: Option<usize>,
    invalid: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<PromptEvent> for PromptField {}

impl PromptField {
    pub fn new(placeholder: &str, placeholders: Vec<Placeholder>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = TextArea::state(placeholder.to_string(), (5, 12), window, cx);
        let typing = cx.subscribe(&state, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.emit(PromptEvent::Changed);
            }
            this.look(cx);
        });
        // A caret move notifies without a Change.
        let moved = cx.observe(&state, |this, _, cx| this.look(cx));
        Self { state, placeholders, open: None, active: 0, dismissed: None, invalid: false, _subscriptions: vec![typing, moved] }
    }

    pub fn value(&self, cx: &App) -> String {
        self.state.read(cx).value().to_string()
    }

    pub fn set_value(&mut self, value: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_value(value.to_string(), window, cx));
    }

    /// Sets the text with the caret at its end, as typing it would (tests).
    #[cfg(test)]
    pub(crate) fn type_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let end = text.len();
        self.state.update(cx, |state, cx| {
            state.set_value(text.to_string(), window, cx);
            state.set_selected_range(end..end, cx);
        });
        self.look(cx);
    }

    pub fn set_placeholders(&mut self, placeholders: Vec<Placeholder>, cx: &mut Context<Self>) {
        if self.placeholders != placeholders {
            self.placeholders = placeholders;
            self.look(cx);
        }
    }

    pub fn set_invalid(&mut self, invalid: bool, cx: &mut Context<Self>) {
        if self.invalid != invalid {
            self.invalid = invalid;
            cx.notify();
        }
    }

    /// Reads the text and caret and opens, narrows or closes the list.
    fn look(&mut self, cx: &mut Context<Self>) {
        let (text, caret) = self.state.read_with(cx, |state, _| (state.value().to_string(), state.selected_range().start));
        let names: Vec<&'static str> = self.placeholders.iter().map(|entry| entry.name).collect();
        let found = placeholder_query(&text, caret, &names);
        let next = match found {
            None => {
                self.dismissed = None;
                None
            }
            Some(found) if Some(found.start) == self.dismissed || found.matches.is_empty() => None,
            Some(found) => Some(found),
        };
        if next != self.open {
            if next.as_ref().map(|q| (q.start, q.matches.len())) != self.open.as_ref().map(|q| (q.start, q.matches.len())) {
                self.active = 0;
            }
            self.open = next;
            cx.notify();
        }
    }

    fn move_active(&mut self, step: isize, cx: &mut Context<Self>) -> bool {
        let Some(open) = &self.open else { return false };
        let len = open.matches.len() as isize;
        self.active = (self.active as isize + step).rem_euclid(len) as usize;
        cx.notify();
        true
    }

    /// Inserts the placeholder `name` for what was typed.
    pub fn choose(&mut self, name: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(open) = self.open.take() else { return };
        let (text, caret) = self.state.read_with(cx, |state, _| (state.value().to_string(), state.selected_range().start));
        let (next, caret) = match dynamic_prefix(name) {
            // A dynamic name leaves the caret where the path goes.
            Some(prefix) => (format!("{}{{{{{prefix}{}", &text[..open.start], &text[caret..]), open.start + 2 + prefix.len()),
            None => insert_placeholder(&text, open.start, caret, name),
        };
        self.state.update(cx, |state, cx| {
            state.set_value(next, window, cx);
            state.set_selected_range(caret..caret, cx);
            state.focus(window, cx);
        });
        cx.emit(PromptEvent::Changed);
        cx.notify();
    }

    fn pick_active(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(name) = self.open.as_ref().and_then(|open| open.matches.get(self.active).or(open.matches.first()).copied()) else {
            return false;
        };
        self.choose(name, window, cx);
        true
    }

    fn on_enter(&mut self, _: &Enter, window: &mut Window, cx: &mut Context<Self>) {
        if self.pick_active(window, cx) {
            cx.stop_propagation();
        }
    }

    fn on_tab(&mut self, _: &IndentInline, window: &mut Window, cx: &mut Context<Self>) {
        if self.pick_active(window, cx) {
            cx.stop_propagation();
        }
    }

    fn on_up(&mut self, _: &MoveUp, _: &mut Window, cx: &mut Context<Self>) {
        if self.move_active(-1, cx) {
            cx.stop_propagation();
        }
    }

    fn on_down(&mut self, _: &MoveDown, _: &mut Window, cx: &mut Context<Self>) {
        if self.move_active(1, cx) {
            cx.stop_propagation();
        }
    }

    fn on_escape(&mut self, _: &Escape, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(open) = self.open.take() {
            self.dismissed = Some(open.start);
            cx.stop_propagation();
            cx.notify();
        }
    }

    fn list(&self, open: &PlaceholderQuery, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let entity = cx.entity();
        let rows = open.matches.iter().enumerate().filter_map(|(ix, name)| {
            let entry = self.placeholders.iter().find(|entry| entry.name == *name)?;
            let (name, example) = (entry.name, entry.example);
            let active = ix == self.active;
            let entity = entity.clone();
            let hover = theme.hover2;
            Some(
                div()
                    .id(SharedString::from(format!("routine-placeholder-{name}")))
                    .debug_selector(move || format!("routine-placeholder-{name}"))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .h(px(ROW_HEIGHT))
                    .flex_none()
                    .px(px(8.0))
                    .rounded(crate::theme::RADIUS_CONTROL)
                    .text_step(TEXT_13)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink)
                    .when(active, |el| el.bg(theme.hover2))
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    // Keep focus in the text area while picking with the mouse.
                    .on_mouse_down(gpui::MouseButton::Left, |_, window, cx| {
                        window.prevent_default();
                        cx.stop_propagation();
                    })
                    .on_click(move |_, window, cx| entity.update(cx, |this, cx| this.choose(name, window, cx)))
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .size(px(20.0))
                            .child(Icon::new(IconName::Code).size(IconSize::S16).color(theme.ink2)),
                    )
                    .child(div().flex_none().child(name))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_right()
                            .text_step(TEXT_11)
                            .font_weight(FontWeight::NORMAL)
                            .text_color(theme.ink3)
                            .child(example),
                    ),
            )
        });
        deferred(
            div()
                .absolute()
                .top_full()
                .left_0()
                .mt(px(4.0))
                .w(px(LIST_WIDTH))
                .max_h(px(MAX_LIST))
                .occlude()
                .debug_selector(|| "routine-placeholders".into())
                .flex()
                .flex_col()
                .p(px(6.0))
                .rounded(RADIUS_CARD)
                .bg(theme.surface)
                .shadow(theme.shadow_raised())
                .children(rows),
        )
        .with_priority(10)
        .into_any_element()
    }
}

impl Render for PromptField {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let open = self.open.clone();
        div()
            .relative()
            .w_full()
            .capture_action(cx.listener(Self::on_enter))
            .capture_action(cx.listener(Self::on_tab))
            .capture_action(cx.listener(Self::on_up))
            .capture_action(cx.listener(Self::on_down))
            .on_action(cx.listener(Self::on_escape))
            .child(TextArea::new("routine-prompt", &self.state).invalid(self.invalid))
            .children(open.map(|open| self.list(&open, cx)))
    }
}
