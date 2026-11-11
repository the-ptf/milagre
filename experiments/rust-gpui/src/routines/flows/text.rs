//! A step's text that can read fields (`FieldText` in `FlowInspector.tsx`): a label with "Insert field" at its end, and
//! a text area where typing `{{` lists the fields the step can read. Insert field puts `{{ref}}` where the caret was.
//!
//! The `{{` list is `routines::placeholders`' (the same keys and rows) over this step's refs, which change as the flow is
//! edited, so the names are owned strings.

use gpui::{
    AnyElement, Context, Entity, EventEmitter, FontWeight, IntoElement, Render, SharedString, Subscription, Window, deferred, div,
    prelude::*, px,
};
use gpui_component::input::{Enter, Escape, IndentInline, InputEvent, MoveDown, MoveUp, TextareaState};

use super::ops::Readable;
use crate::routines::prompt::insert_placeholder;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt, mono};
use crate::ui::{Icon, IconName, IconSize, Popover, TextArea};

const ROW_HEIGHT: f32 = 32.0;
const MAX_LIST: f32 = 280.0;

pub enum TextEvent {
    Changed,
}

/// The `{{` being typed: where it starts and the refs that begin with what follows.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Query {
    start: usize,
    matches: Vec<String>,
}

/// `placeholderQuery` over owned names.
fn query(text: &str, caret: usize, names: &[String]) -> Option<Query> {
    let caret = caret.min(text.len());
    let before = text.get(..caret)?;
    let last = before.rfind("{{")?;
    let name = before[last + 2..].trim_start_matches([' ', '\t']);
    if name.chars().any(|c| c.is_whitespace() || c == '{' || c == '}') {
        return None;
    }
    let mut start = last;
    while start > 0 && before.as_bytes()[start - 1] == b'{' {
        start -= 1;
    }
    let prefix = name.to_lowercase();
    Some(Query { start, matches: names.iter().filter(|n| n.to_lowercase().starts_with(&prefix)).cloned().collect() })
}

pub struct FlowText {
    id: SharedString,
    label: &'static str,
    state: Entity<TextareaState>,
    fields: Vec<Readable>,
    open: Option<Query>,
    active: usize,
    dismissed: Option<usize>,
    invalid: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<TextEvent> for FlowText {}

impl FlowText {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: &str,
        label: &'static str,
        placeholder: &str,
        rows: usize,
        value: &str,
        fields: Vec<Readable>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = TextArea::state(placeholder.to_string(), (rows, rows.max(12)), window, cx);
        state.update(cx, |state, cx| state.set_value(value.to_string(), window, cx));
        let typing = cx.subscribe(&state, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.emit(TextEvent::Changed);
            }
            this.look(cx);
        });
        let moved = cx.observe(&state, |this, _, cx| this.look(cx));
        Self {
            id: id.to_string().into(),
            label,
            state,
            fields,
            open: None,
            active: 0,
            dismissed: None,
            invalid: false,
            _subscriptions: vec![typing, moved],
        }
    }

    pub fn value(&self, cx: &gpui::App) -> String {
        self.state.read(cx).value().to_string()
    }

    pub fn set_fields(&mut self, fields: Vec<Readable>, cx: &mut Context<Self>) {
        if self.fields != fields {
            self.fields = fields;
            self.look(cx);
            cx.notify();
        }
    }

    pub fn set_invalid(&mut self, invalid: bool, cx: &mut Context<Self>) {
        if self.invalid != invalid {
            self.invalid = invalid;
            cx.notify();
        }
    }

    /// Sets the text with the caret at its end, as typing it would (tests).
    #[cfg(test)]
    pub fn type_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let end = text.len();
        self.state.update(cx, |state, cx| {
            state.set_value(text.to_string(), window, cx);
            state.set_selected_range(end..end, cx);
        });
        self.look(cx);
    }

    #[cfg(test)]
    pub fn listed(&self) -> Vec<String> {
        self.open.as_ref().map(|open| open.matches.clone()).unwrap_or_default()
    }

    fn look(&mut self, cx: &mut Context<Self>) {
        let (text, caret) = self.state.read_with(cx, |state, _| (state.value().to_string(), state.selected_range().start));
        let names: Vec<String> = self.fields.iter().map(|field| field.ref_.clone()).collect();
        let next = match query(&text, caret, &names) {
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

    /// Inserts `{{name}}` for what was typed after a `{{`.
    fn choose(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(open) = self.open.take() else { return };
        let (text, caret) = self.state.read_with(cx, |state, _| (state.value().to_string(), state.selected_range().start));
        let (next, caret) = insert_placeholder(&text, open.start, caret, name);
        self.state.update(cx, |state, cx| {
            state.set_value(next, window, cx);
            state.set_selected_range(caret..caret, cx);
            state.focus(window, cx);
        });
        cx.emit(TextEvent::Changed);
        cx.notify();
    }

    /// Insert field: `{{ref}}` where the caret was (at the end when the text never had one).
    pub fn insert(&mut self, ref_: &str, window: &mut Window, cx: &mut Context<Self>) {
        let (text, range) = self.state.read_with(cx, |state, _| (state.value().to_string(), state.selected_range()));
        let (start, end) = (range.start.min(text.len()), range.end.min(text.len()));
        let next = format!("{}{{{{{ref_}}}}}{}", &text[..start], &text[end..]);
        let caret = start + ref_.len() + 4;
        self.state.update(cx, |state, cx| {
            state.set_value(next, window, cx);
            state.set_selected_range(caret..caret, cx);
            state.focus(window, cx);
        });
        cx.emit(TextEvent::Changed);
        cx.notify();
    }

    fn pick_active(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(name) = self.open.as_ref().and_then(|open| open.matches.get(self.active).or(open.matches.first()).cloned()) else {
            return false;
        };
        self.choose(&name, window, cx);
        true
    }

    fn move_active(&mut self, step: isize, cx: &mut Context<Self>) -> bool {
        let Some(open) = &self.open else { return false };
        self.active = (self.active as isize + step).rem_euclid(open.matches.len() as isize) as usize;
        cx.notify();
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

    fn list(&self, open: &Query, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let entity = cx.entity();
        let rows = open.matches.iter().enumerate().filter_map(|(ix, name)| {
            let field = self.fields.iter().find(|field| &field.ref_ == name)?;
            let (name, step) = (name.clone(), field.step_name.clone());
            let entity = entity.clone();
            let selector = format!("flow-placeholder-{name}");
            Some(
                div()
                    .id(SharedString::from(selector.clone()))
                    .debug_selector(move || selector.clone())
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .h(px(ROW_HEIGHT))
                    .flex_none()
                    .px(px(8.0))
                    .rounded(RADIUS_CONTROL)
                    .text_step(TEXT_13)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink)
                    .when(ix == self.active, |el| el.bg(theme.hover2))
                    .cursor_pointer()
                    .hover(move |style| style.bg(theme.hover2))
                    .on_mouse_down(gpui::MouseButton::Left, |_, window, cx| {
                        window.prevent_default();
                        cx.stop_propagation();
                    })
                    .on_click({
                        let name = name.clone();
                        move |_, window, cx| entity.update(cx, |this, cx| this.choose(&name, window, cx))
                    })
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
                            .child(step),
                    ),
            )
        });
        deferred(
            div()
                .absolute()
                .top_full()
                .left_0()
                .mt(px(4.0))
                .w(px(320.0))
                .max_h(px(MAX_LIST))
                .occlude()
                .debug_selector(|| "flow-placeholders".into())
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

    /// The Insert field panel: the readable fields grouped under the step that gives them.
    fn insert_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let entity = cx.entity();
        let fields = self.fields.clone();
        let id = self.id.clone();
        let disabled = fields.is_empty();
        Popover::new(SharedString::from(format!("{id}-insert")))
            .width(px(300.0))
            .trigger(move |open| {
                div()
                    .id(SharedString::from(format!("{id}-insert-trigger")))
                    .debug_selector({
                        let selector = format!("{id}-insert-trigger");
                        move || selector.clone()
                    })
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .h(px(24.0))
                    .px(px(6.0))
                    .rounded(crate::theme::RADIUS_CHIP)
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.accent_ink)
                    .when(disabled, |el| el.opacity(0.4))
                    .when(!disabled, |el| el.cursor_pointer().hover(move |s| s.bg(theme.accent_tint)))
                    .when(open, |el| el.bg(theme.accent_tint))
                    .child(Icon::new(IconName::PlusSign).size(IconSize::S12).color(theme.accent_ink))
                    .child("Insert field")
                    .into_any_element()
            })
            .content(move |dismiss, _window, _cx| {
                let mut list = div().id("flow-insert-list").flex().flex_col().max_h(px(MAX_LIST)).overflow_y_scroll();
                let mut last_step: Option<String> = None;
                for field in &fields {
                    if last_step.as_deref() != Some(field.step_name.as_str()) {
                        list = list.child(
                            div()
                                .px(px(8.0))
                                .pt(px(8.0))
                                .pb(px(4.0))
                                .text_step(TEXT_11)
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.ink3)
                                .child(field.step_name.clone()),
                        );
                        last_step = Some(field.step_name.clone());
                    }
                    let (entity, dismiss, ref_) = (entity.clone(), dismiss.clone(), field.ref_.clone());
                    let selector = format!("flow-field-{}", field.ref_);
                    list = list.child(
                        div()
                            .id(SharedString::from(selector.clone()))
                            .debug_selector(move || selector.clone())
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .h(px(32.0))
                            .flex_none()
                            .px(px(8.0))
                            .rounded(RADIUS_CONTROL)
                            .cursor_pointer()
                            .hover(move |s| s.bg(theme.hover2))
                            .on_click(move |_, window, cx| {
                                dismiss.call(window, cx);
                                let ref_ = ref_.clone();
                                entity.update(cx, |this, cx| this.insert(&ref_, window, cx));
                            })
                            .child(Icon::new(super::look::field_icon(field.ty)).size(IconSize::S14).color(theme.ink3))
                            .child(div().flex_1().min_w_0().truncate().text_step(TEXT_13).text_color(theme.ink).child(field.label.clone()))
                            .child(
                                div().flex_none().font_family(mono()).text_step(TEXT_11).text_color(theme.ink3).child(field.ref_.clone()),
                            ),
                    );
                }
                list.into_any_element()
            })
            .into_any_element()
    }
}

impl Render for FlowText {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let open = self.open.clone();
        let selector = format!("flow-text-{}", self.id);
        div()
            .debug_selector(move || selector.clone())
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .min_h(px(24.0))
                    .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(self.label))
                    .child(self.insert_menu(cx)),
            )
            .child(
                div()
                    .relative()
                    .w_full()
                    .capture_action(cx.listener(Self::on_enter))
                    .capture_action(cx.listener(Self::on_tab))
                    .capture_action(cx.listener(Self::on_up))
                    .capture_action(cx.listener(Self::on_down))
                    .on_action(cx.listener(Self::on_escape))
                    .child(TextArea::new(SharedString::from(format!("flow-textarea-{}", self.id)), &self.state).invalid(self.invalid))
                    .children(open.map(|open| self.list(&open, cx))),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typing_braces_lists_the_refs_that_begin_with_what_follows() {
        let names: Vec<String> = ["trigger.issue.key", "trigger.issue.title", "classify.area"].map(String::from).to_vec();
        let found = query("Fix {{trigger.i", 15, &names).unwrap();
        assert_eq!((found.start, found.matches), (4, vec!["trigger.issue.key".to_string(), "trigger.issue.title".to_string()]));
        assert_eq!(query("{{cl", 4, &names).unwrap().matches, ["classify.area"]);
        assert_eq!(query("{{classify.area}} next", 22, &names), None);
        assert_eq!(query("plain", 5, &names), None);
    }
}
