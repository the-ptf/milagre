//! [`PickerPanel`] and [`PickerRow`] (the desktop's `primitives/Picker.tsx`): the panel behind the model,
//! permission and branch pickers and behind [`Select`](super::Select).
//!
//! Our own composition over the wrapped [`Popover`](super::Popover) for its surface and dismissal and over
//! [`Input`](super::Input) for its search field, with the menu rows' metrics (`popover::row_shell`): gpui-component's
//! `Select` and `List` keep their rows in a delegate and an entity with their own look, and the picker's rows
//! (meta chips, a trailing computer name, wrapped labels, a label in its own font) would be overrides all the way
//! down. A [`PickerRow`] is 32px (48 with a description), 13 medium label, 11 `ink-3` description, a trailing 11px
//! text and a 14px tick for the selected row (no fill: selection is a tick, DESIGN.md "States"); hover, keyboard
//! focus and the inset ring are the menu row's.
//!
//! The panel is `surface`, `rounded-card`, `shadow-raised`, 6px padding; an optional title (13 semibold) with an
//! action beside it, an optional header slot (provider tabs), an optional search field, and the rows in a list at
//! most 256px high that scrolls. Up and Down move between rows (wrapping), Enter presses the focused row or, from
//! the search field, the first one; an empty list shows `empty_label` in 12px `ink-3`.
//!
//! ```ignore
//! PickerPanel::new("model-picker")
//!     .title("Model")
//!     .search(&query_state)
//!     .row(PickerRow::new("opus", "Opus 5.5").description("Most capable").selected(true).on_click(|_, _| ..))
//!     .into_element()
//! ```

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, FocusHandle, FontWeight, IntoElement, KeyDownEvent, ParentElement, RenderOnce, SharedString,
    Window, div, prelude::*, px,
};
use gpui_component::input::InputState;

use super::focus::{RovingAxis, focused_index, item_focus, roving_index};
use super::popover::row_shell;
use super::scroll_fade::ScrollFade;
use super::{Icon, IconName, IconSize, Input, SectionLabel};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_INLINE, TEXT_10, TEXT_11, TEXT_12, TEXT_13, TextStepExt};

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;

/// A picker choice; see the module docs.
#[derive(IntoElement)]
pub struct PickerRow {
    id: ElementId,
    label: SharedString,
    description: Option<SharedString>,
    meta: Option<SharedString>,
    trailing: Option<SharedString>,
    icon: Option<IconName>,
    selected: bool,
    disabled: bool,
    handle: Option<FocusHandle>,
    on_click: Option<Handler>,
}

impl PickerRow {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            description: None,
            meta: None,
            trailing: None,
            icon: None,
            selected: false,
            disabled: false,
            handle: None,
            on_click: None,
        }
    }

    /// A line of 11px `ink-3` text under the label; the row is 48 high.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// A short fact in a `field` chip beside the label (a model's context window).
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// Right-aligned 11px text before the tick (the computer a Project lives on).
    pub fn trailing(mut self, trailing: impl Into<SharedString>) -> Self {
        self.trailing = Some(trailing.into());
        self
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// The chosen row shows the 14px tick.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for PickerRow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let handle = self.handle.clone().unwrap_or_else(|| item_focus(&self.id, window, cx));
        let selector = self.id.to_string();
        let height = if self.description.is_some() { 48.0 } else { 32.0 };
        let enabled = !self.disabled;
        row_shell(self.id, handle, px(height), theme.ink, enabled, &theme)
            .debug_selector(move || selector.clone())
            .when_some(self.on_click.filter(|_| enabled), |el, handler| el.on_click(move |_, window, cx| handler(window, cx)))
            .when_some(self.icon, |el, icon| {
                el.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(20.0))
                        .child(Icon::new(icon).size(IconSize::S14).color(theme.ink2)),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(div().flex().items_center().gap(px(6.0)).min_w_0().child(div().truncate().child(self.label)).when_some(
                        self.meta,
                        |el, meta| {
                            el.child(
                                div()
                                    .flex_none()
                                    .px(px(4.0))
                                    .rounded(RADIUS_INLINE)
                                    .bg(theme.field)
                                    .text_step(TEXT_10)
                                    .text_color(theme.ink3)
                                    .child(meta),
                            )
                        },
                    ))
                    .when_some(self.description, |el, text| {
                        el.child(div().truncate().text_step(TEXT_11).font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(text))
                    }),
            )
            .when_some(self.trailing, |el, text| {
                el.child(
                    div()
                        .flex_none()
                        .max_w(gpui::relative(0.4))
                        .truncate()
                        .text_step(TEXT_11)
                        .font_weight(FontWeight::NORMAL)
                        .text_color(theme.ink3)
                        .child(text),
                )
            })
            .when(self.selected, |el| {
                el.child(
                    div()
                        .debug_selector(|| "picker-tick".into())
                        .flex_none()
                        .child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink)),
                )
            })
    }
}

enum Item {
    Row(PickerRow),
    Label(SharedString),
}

/// The popover panel around picker rows; see the module docs.
#[derive(IntoElement)]
pub struct PickerPanel {
    id: ElementId,
    title: Option<SharedString>,
    title_action: Option<AnyElement>,
    header: Option<AnyElement>,
    search: Option<Entity<InputState>>,
    empty_label: SharedString,
    items: Vec<Item>,
    width: Option<f32>,
}

impl PickerPanel {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            title: None,
            title_action: None,
            header: None,
            search: None,
            empty_label: "No matches".into(),
            items: Vec::new(),
            width: None,
        }
    }

    /// A 13 semibold heading.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// An element beside the title (a refresh button).
    pub fn title_action(mut self, action: impl IntoElement) -> Self {
        self.title_action = Some(action.into_any_element());
        self
    }

    /// An element above the list (provider tabs).
    pub fn header(mut self, header: impl IntoElement) -> Self {
        self.header = Some(header.into_any_element());
        self
    }

    /// A search field over the list, bound to `query` (an `Input::state`); filtering is the caller's.
    pub fn search(mut self, query: &Entity<InputState>) -> Self {
        self.search = Some(query.clone());
        self
    }

    /// What the list says when it has no rows.
    pub fn empty_label(mut self, label: impl Into<SharedString>) -> Self {
        self.empty_label = label.into();
        self
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = Some(width);
        self
    }

    pub fn row(mut self, row: PickerRow) -> Self {
        self.items.push(Item::Row(row));
        self
    }

    /// A group heading (11 medium `ink-3`), inset to the rows' text.
    pub fn label(mut self, text: impl Into<SharedString>) -> Self {
        self.items.push(Item::Label(text.into()));
        self
    }
}

impl RenderOnce for PickerPanel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let mut rows: Vec<(FocusHandle, Option<Handler>, bool)> = Vec::new();
        for item in &self.items {
            if let Item::Row(row) = item {
                rows.push((item_focus(&row.id, window, cx), row.on_click.clone(), row.disabled));
            }
        }
        let empty = rows.is_empty();
        let handles: Vec<FocusHandle> = rows.iter().map(|(handle, ..)| handle.clone()).collect();
        let mut next = handles.clone().into_iter();
        let selector = self.id.to_string();
        let (list_scroll, list_fade) = ScrollFade::kept(&ElementId::from((self.id.clone(), "list")), window, cx);
        div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .flex()
            .flex_col()
            .p(px(6.0))
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(theme.shadow_raised())
            .text_color(theme.ink)
            .when_some(self.width, |el, width| el.w(px(width)))
            .on_key_down(move |event: &KeyDownEvent, window, cx| {
                let key = event.keystroke.key.as_str();
                let current = focused_index(&handles, window);
                if key == "enter" {
                    // The focused row, or from the search field the first enabled one.
                    let target = current.or_else(|| rows.iter().position(|(_, _, disabled)| !disabled));
                    if let Some((_, Some(handler), false)) = target.and_then(|ix| rows.get(ix)) {
                        handler(window, cx);
                        cx.stop_propagation();
                    }
                } else if let Some(to) =
                    roving_index(key, current, handles.len(), RovingAxis::Vertical).filter(|_| matches!(key, "up" | "down"))
                {
                    handles[to].focus(window, cx);
                    cx.stop_propagation();
                }
            })
            .when_some(self.title, |el, title| {
                el.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_between()
                        .gap(px(8.0))
                        .px(px(8.0))
                        .pt(px(4.0))
                        .pb(px(8.0))
                        .child(div().text_step(TEXT_13).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(title))
                        .children(self.title_action),
                )
            })
            .children(self.header)
            .when_some(self.search, |el, query| {
                el.child(div().flex_none().my(px(8.0)).child(Input::new("picker-search", &query).leading(IconName::Search01)))
            })
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .min_h_0()
                    .child(
                        div()
                            .id("picker-list")
                            .flex()
                            .flex_col()
                            .gap(px(1.0))
                            .max_h(px(256.0))
                            .overflow_y_scroll()
                            .track_scroll(&list_scroll)
                            .children(self.items.into_iter().enumerate().map(move |(ix, item)| {
                                match item {
                                    Item::Row(mut row) => {
                                        row.handle = next.next();
                                        row.into_any_element()
                                    }
                                    Item::Label(text) => div()
                                        .id(("picker-label", ix))
                                        .flex_none()
                                        .px(px(8.0))
                                        .pt(px(8.0))
                                        .pb(px(4.0))
                                        .child(SectionLabel::new(text).menu())
                                        .into_any_element(),
                                }
                            }))
                            .when(empty, |el| {
                                el.child(
                                    div()
                                        .px(px(8.0))
                                        .py(px(20.0))
                                        .text_center()
                                        .text_step(TEXT_12)
                                        .text_color(theme.ink3)
                                        .child(self.empty_label),
                                )
                            }),
                    )
                    .child(list_fade.overlay(theme.surface.into())),
            )
    }
}
