//! [`RadioGroup`] (DESIGN.md "States": a radio group for one choice out of several; the desktop's
//! `primitives/RadioGroup.tsx`): 16px radios, an `ink-3` ring at rest, an ink fill with an 8px `on-ink` dot when
//! picked. Selection is ink, never accent. Our own: gpui-component's `Radio` is a 14px accent-tinted box with its
//! own label, and the unstyled gpui-base `Radio` has no group keyboard model (its `RadioGroup` is a container),
//! so the roving keys are `focus::roving_keys`.
//!
//! One Tab stop (the picked radio, else the first enabled), the arrow keys, Home and End move the focus and pick;
//! each radio has the accent focus ring while focused from the keyboard. A label is 13 medium `ink`; a click on it
//! picks the radio too.
//!
//! ```ignore
//! RadioGroup::new("scope", Some("all"), [RadioOption::new("all", "Every Project"), RadioOption::new("this", "This one")])
//!     .on_change(|value, _, _| ...)
//! ```

use std::rc::Rc;

use gpui::{App, ElementId, FocusHandle, FontWeight, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px};

use super::focus::{RovingAxis, focus_ring, item_focus, roving_keys};
use crate::theme::{ActiveTheme, TEXT_13, TextStepExt};

type Change = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

#[derive(Clone)]
pub struct RadioOption {
    value: SharedString,
    label: SharedString,
    disabled: bool,
}

impl RadioOption {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self { value: value.into(), label: label.into(), disabled: false }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

#[derive(IntoElement)]
pub struct RadioGroup {
    id: ElementId,
    value: Option<SharedString>,
    options: Vec<RadioOption>,
    horizontal: bool,
    disabled: bool,
    on_change: Option<Change>,
}

impl RadioGroup {
    pub fn new(id: impl Into<ElementId>, value: Option<&str>, options: impl IntoIterator<Item = RadioOption>) -> Self {
        Self {
            id: id.into(),
            value: value.map(|value| SharedString::from(value.to_string())),
            options: options.into_iter().collect(),
            horizontal: false,
            disabled: false,
            on_change: None,
        }
    }

    /// Radios in a row instead of a column.
    pub fn horizontal(mut self) -> Self {
        self.horizontal = true;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with the picked value (a click, or an arrow key moving the choice).
    pub fn on_change(mut self, handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for RadioGroup {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let enabled: Vec<usize> = (0..self.options.len()).filter(|&ix| !self.disabled && !self.options[ix].disabled).collect();
        let handles: Vec<FocusHandle> =
            self.options.iter().map(|option| item_focus(&ElementId::from((self.id.clone(), option.value.clone())), window, cx)).collect();
        // One Tab stop: the picked radio, else the first enabled one.
        let stop =
            enabled.iter().copied().find(|&ix| Some(&self.options[ix].value) == self.value.as_ref()).or_else(|| enabled.first().copied());
        let keys = {
            let (options, change) = (self.options.clone(), self.on_change.clone());
            roving_keys(
                enabled.iter().map(|&ix| handles[ix].clone()).collect(),
                enabled.clone(),
                if self.horizontal { RovingAxis::Horizontal } else { RovingAxis::Both },
                move |ix, window, cx| {
                    if let Some(change) = &change {
                        change(&options[ix].value, window, cx);
                    }
                },
            )
        };
        let group_selector = self.id.to_string();
        div()
            .id(self.id.clone())
            .debug_selector(move || group_selector.clone())
            .flex()
            .gap(px(12.0))
            .when(!self.horizontal, |el| el.flex_col())
            .on_key_down(keys)
            .children(self.options.iter().enumerate().map(|(ix, option)| {
                let checked = Some(&option.value) == self.value.as_ref();
                let usable = enabled.contains(&ix);
                let handle = handles[ix].clone().tab_stop(stop == Some(ix));
                let item_id = ElementId::from((self.id.clone(), option.value.clone()));
                let selector = item_id.to_string();
                let pick = {
                    let (value, change) = (option.value.clone(), self.on_change.clone());
                    move |window: &mut Window, cx: &mut App| {
                        if let Some(change) = &change {
                            change(&value, window, cx);
                        }
                    }
                };
                let pick_label = pick.clone();
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.0))
                    .when(!usable, |el| el.opacity(0.4))
                    .child(
                        div()
                            .id(item_id)
                            .debug_selector(move || selector.clone())
                            .track_focus(&handle)
                            .relative()
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .size(px(16.0))
                            .rounded_full()
                            .border_1()
                            .when(checked, |el| el.bg(theme.ink).border_color(theme.ink))
                            .when(!checked, |el| el.bg(theme.surface).border_color(theme.ink3))
                            .when(usable, |el| el.cursor_pointer().on_click(move |_, window, cx| pick(window, cx)))
                            .when(checked, |el| el.child(div().size(px(8.0)).rounded_full().bg(theme.on_ink)))
                            .child(focus_ring(&handle, px(8.0))),
                    )
                    .child(
                        div()
                            .id((ElementId::from((self.id.clone(), option.value.clone())), "label"))
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink)
                            .when(usable, |el| el.cursor_pointer().on_click(move |_, window, cx| pick_label(window, cx)))
                            .child(option.label.clone()),
                    )
            }))
    }
}
